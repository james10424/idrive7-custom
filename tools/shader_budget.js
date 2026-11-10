"use strict";
/**
 * What an effect shader asks of the instrument cluster's GPU (the KOMBI), measured against what ran on the car.
 *
 * Past some size the KOMBI restarts about 2 s after the layer shows (tools/live2d_bake/README.md "What the cluster can
 * take"). The limit itself is unknown; we know one shader that crashed and ones that hold:
 *
 *   Custom HUD 0.1.15, Miku with all parts (2babaab)    38 texture reads, 7008 tokens   restarted the KOMBI
 *   Custom HUD 0.1.16/0.1.17, Miku (8eeadc1, 181e2ae)   32 texture reads, 5340 tokens   holds
 *   Custom Cluster Sport (sdash, 0.1.35)                  0 texture reads, 7835 tokens   holds
 *
 * Sport is bigger than the crashed Miku and runs, so size alone is not it: the texture reads are what set the crash
 * apart. Both are counted as the compiler sees them, with every function inlined into main (a function called 6 times
 * counts 6 times), after the #ifdefs. Loops count their body once (none of the shaders that matter loop over reads).
 *
 * Used by bench/server.js on every effect layer, and from the command line on every widget type's shaders
 * (shared/widgets, each module's "shaders"):
 *   node tools/shader_budget.js        (exits 1 if any shader reaches the crash mark)
 */

// Texture reads: over GOOD is untested on the car, at CRASH or over is what restarted it.
const READS_GOOD = 32;
const READS_CRASH = 38;
// Tokens: the biggest shader that runs on the car (Sport). Over it is untested, not known to crash.
const TOKENS_GOOD = 7835;

/**
 * @typedef {object} ShaderCost
 * @property {number} reads texture2D calls, inlined
 * @property {number} tokens
 */
/**
 * @typedef {object} ShaderCheck
 * @property {"ok" | "warn" | "crash"} level
 * @property {string} text
 * @property {number} reads
 * @property {number} tokens
 */

/**
 * The source as the GPU compiles it: no comments, #define NAME / #ifdef / #ifndef / #else / #endif applied.
 * @param {string} src
 * @returns {string}
 */
function preprocess(src) {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const defs = new Set(),
    /** @type {boolean[]} */
    on = [],
    /** @type {string[]} */
    out = [];
  for (const line of s.split("\n")) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^#ifdef\s+(\w+)/))) {
      on.push(defs.has(m[1]));
      continue;
    }
    if ((m = t.match(/^#ifndef\s+(\w+)/))) {
      on.push(!defs.has(m[1]));
      continue;
    }
    if (t.startsWith("#else")) {
      on.push(!on.pop());
      continue;
    }
    if (t.startsWith("#endif")) {
      on.pop();
      continue;
    }
    if (!on.every(Boolean)) continue;
    if ((m = t.match(/^#define\s+(\w+)/))) defs.add(m[1]);
    if (!t.startsWith("#")) out.push(line);
  }
  return out.join("\n");
}

const TOKEN =
  /[A-Za-z_]\w*|\d+\.?\d*(?:[eE][-+]?\d+)?|[-+*/<>=!&|]=?|[(){}[\];,.?:]/g;

/**
 * { reads, tokens } of main with every function inlined; null without a main.
 * @param {string} src
 * @returns {ShaderCost | null}
 */
function measure(src) {
  const s = preprocess(src);
  /** @type {Record<string, string>} function name to body */
  const bodies = {};
  const head =
    /\b(?:void|bool|int|float|vec[234]|ivec[234]|bvec[234]|mat[234])\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = head.exec(s))) {
    let i = head.lastIndex,
      depth = 1;
    while (depth && i < s.length) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") depth--;
      i++;
    }
    bodies[m[1]] = s.slice(head.lastIndex, i);
  }
  if (!bodies.main) return null;
  /** @type {Record<string, ShaderCost>} */
  const memo = {};
  /**
   * @param {string} name
   * @returns {ShaderCost}
   */
  const cost = (name) => {
    if (memo[name]) return memo[name];
    const b = bodies[name];
    const r = {
      reads: (b.match(/\btexture2D\s*\(/g) || []).length,
      tokens: (b.match(TOKEN) || []).length,
    };
    for (const f in bodies) {
      if (f === name) continue;
      const n = (b.match(new RegExp("\\b" + f + "\\s*\\(", "g")) || []).length;
      if (n) {
        const c = cost(f);
        r.reads += n * c.reads;
        r.tokens += n * c.tokens;
      }
    }
    return (memo[name] = r);
  };
  return cost("main");
}

/**
 * { level: 'ok' | 'warn' | 'crash', text, reads, tokens } for one fragment shader.
 * @param {string} src
 * @returns {ShaderCheck}
 */
function check(src) {
  const r = measure(src);
  if (!r) return { level: "ok", text: "no main", reads: 0, tokens: 0 };
  const at = r.reads + " texture reads, " + r.tokens + " tokens inlined";
  if (r.reads >= READS_CRASH) {
    return {
      level: "crash",
      text:
        at +
        ": " +
        READS_CRASH +
        " reads restarted the instrument cluster (Custom HUD 0.1.15); cut reads to " +
        READS_GOOD +
        " or fewer",
      ...r,
    };
  }
  /** @type {string[]} */
  const over = [];
  if (r.reads > READS_GOOD)
    over.push(
      "reads over the " +
        READS_GOOD +
        " known to hold (" +
        READS_CRASH +
        " crashed)",
    );
  if (r.tokens > TOKENS_GOOD)
    over.push("size over the " + TOKENS_GOOD + " tokens known to hold");
  if (over.length)
    return {
      level: "warn",
      text: at + ": " + over.join(", ") + "; untested on the car",
      ...r,
    };
  return { level: "ok", text: at, ...r };
}

module.exports = { measure, check, READS_GOOD, READS_CRASH, TOKENS_GOOD };

if (require.main === module) {
  const widgets = require("../shared/widgets");
  const shaders = require("../shared/shaders");
  /** @type {Record<string, string>} every widget type's shaders (its "shaders"), its own first */
  const all = Object.assign({}, shaders, { rdashNeedle: shaders.rdashNeedle });
  Object.keys(widgets).forEach((t) =>
    Object.assign(all, widgets[t].shaders || {}),
  );
  let worst = "ok";
  for (const name of Object.keys(all)) {
    const r = check(all[name]);
    console.log(
      (r.level === "ok" ? "  " : r.level === "warn" ? "! " : "X ") +
        name.padEnd(16) +
        r.text,
    );
    if (r.level === "crash" || (r.level === "warn" && worst === "ok"))
      worst = r.level;
  }
  process.exit(worst === "crash" ? 1 : 0);
}
