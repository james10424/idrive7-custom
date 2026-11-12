"use strict";
/**
 * What an effect shader asks of the instrument cluster's GPU (the KOMBI), measured against what ran on the car.
 *
 * Past some size the KOMBI restarts about 2 s after the layer shows (tools/live2d_bake/README.md "What the cluster can
 * take"). The limits themselves are unknown; we know shaders that crashed and ones that hold:
 *
 *   Custom HUD 0.1.15, Miku with all parts (2babaab)    38 texture reads, 7008 tokens   restarted the KOMBI
 *   Custom Cluster M (mdash, removed in 0.1.43)           0 texture reads, 8724 tokens   crashed the display (Nov 10 2026)
 *   Custom HUD 0.1.16/0.1.17, Miku (8eeadc1, 181e2ae)   32 texture reads, 5340 tokens   holds
 *   Custom Cluster Sport (sdash, 0.1.35)                  0 texture reads, 7835 tokens   holds
 *   Custom Cluster M split (mdash parts, 0.1.43)        0 reads, 4413 + 4361 tokens   holds (Nov 10 2026)
 *
 * Either can crash it: the crashed Miku is smaller than Sport but reads more textures, and M reads none but is
 * bigger than Sport. The limits are per shader, not per screen: M's backdrop split over two layers holds, so a
 * shader past them can be split into smaller ones. Both are counted as the compiler sees them, with every function inlined into main (a function called 6 times
 * counts 6 times), after the #ifdefs. Loops count their body once (none of the shaders that matter loop over reads).
 *
 * Used by bench/server.js on every effect layer, and from the command line on every widget type's shaders
 * (shared/widgets, each module's "shaders", read from the widgets' .glsl files):
 *   node tools/shader_budget.js        (exits 1 if any shader reaches the crash mark or doesn't compile)
 * The command line also compiles each one as GLSL ES 1.00 with Khronos' glslangValidator (brew install glslang),
 * which catches type and syntax errors before a shader reaches the car; without it the compile step is skipped.
 */

// Texture reads: over GOOD is untested on the car, at CRASH or over is what restarted it.
const READS_GOOD = 32;
const READS_CRASH = 38;
// Tokens: over GOOD (Sport, the biggest that runs) is untested, at CRASH or over (M) is what crashed the display.
const TOKENS_GOOD = 7835;
const TOKENS_CRASH = 8724;
// The command line's shader name column width.
const NAME_COL = 16;

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
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const defs = new Set(),
    /** @type {boolean[]} */
    active = [],
    /** @type {string[]} */
    out = [];
  for (const line of code.split("\n")) {
    const trimmed = line.trim();
    let match;
    if ((match = trimmed.match(/^#ifdef\s+(\w+)/))) {
      active.push(defs.has(match[1]));
      continue;
    }
    if ((match = trimmed.match(/^#ifndef\s+(\w+)/))) {
      active.push(!defs.has(match[1]));
      continue;
    }
    if (trimmed.startsWith("#else")) {
      active.push(!active.pop());
      continue;
    }
    if (trimmed.startsWith("#endif")) {
      active.pop();
      continue;
    }
    if (!active.every(Boolean)) continue;
    if ((match = trimmed.match(/^#define\s+(\w+)/))) defs.add(match[1]);
    if (!trimmed.startsWith("#")) out.push(line);
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
  const code = preprocess(src);
  /** @type {Record<string, string>} function name to body */
  const bodies = {};
  const head =
    /\b(?:void|bool|int|float|vec[234]|ivec[234]|bvec[234]|mat[234])\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let match;
  while ((match = head.exec(code))) {
    let i = head.lastIndex,
      depth = 1;
    while (depth && i < code.length) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
      i++;
    }
    bodies[match[1]] = code.slice(head.lastIndex, i);
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
    const body = bodies[name];
    const total = {
      reads: (body.match(/\btexture2D\s*\(/g) || []).length,
      tokens: (body.match(TOKEN) || []).length,
    };
    for (const callee in bodies) {
      if (callee === name) continue;
      const calls = (
        body.match(new RegExp("\\b" + callee + "\\s*\\(", "g")) || []
      ).length;
      if (calls) {
        const calleeCost = cost(callee);
        total.reads += calls * calleeCost.reads;
        total.tokens += calls * calleeCost.tokens;
      }
    }
    return (memo[name] = total);
  };
  return cost("main");
}

/**
 * { level: 'ok' | 'warn' | 'crash', text, reads, tokens } for one fragment shader.
 * @param {string} src
 * @returns {ShaderCheck}
 */
function check(src) {
  const measured = measure(src);
  if (!measured) return { level: "ok", text: "no main", reads: 0, tokens: 0 };
  const summary =
    measured.reads + " texture reads, " + measured.tokens + " tokens inlined";
  if (measured.reads >= READS_CRASH) {
    return {
      level: "crash",
      text:
        summary +
        ": " +
        READS_CRASH +
        " reads restarted the instrument cluster (Custom HUD 0.1.15); cut reads to " +
        READS_GOOD +
        " or fewer",
      ...measured,
    };
  }
  if (measured.tokens >= TOKENS_CRASH) {
    return {
      level: "crash",
      text:
        summary +
        ": " +
        TOKENS_CRASH +
        " tokens crashed the display (Custom Cluster's M theme); cut it to " +
        TOKENS_GOOD +
        " or fewer",
      ...measured,
    };
  }
  /** @type {string[]} */
  const over = [];
  if (measured.reads > READS_GOOD)
    over.push(
      "reads over the " +
        READS_GOOD +
        " known to hold (" +
        READS_CRASH +
        " crashed)",
    );
  if (measured.tokens > TOKENS_GOOD)
    over.push(
      "size over the " +
        TOKENS_GOOD +
        " tokens known to hold (" +
        TOKENS_CRASH +
        " crashed)",
    );
  if (over.length)
    return {
      level: "warn",
      text: summary + ": " + over.join(", ") + "; untested on the car",
      ...measured,
    };
  return { level: "ok", text: summary, ...measured };
}

/**
 * Compiles a fragment shader as GLSL ES 1.00 with glslangValidator.
 * @param {string} src
 * @returns {{ ok: boolean, missing?: boolean, errors: string }} errors: the compiler's ERROR lines
 */
function compile(src) {
  const run = require("child_process").spawnSync(
    "glslangValidator",
    ["--stdin", "-S", "frag"],
    { input: src, encoding: "utf8" },
  );
  if (run.error)
    return { ok: false, missing: true, errors: String(run.error.message) };
  const errors = (run.stdout + run.stderr)
    .split("\n")
    .filter(
      (line) =>
        /^(ERROR|WARNING):/.test(line) &&
        !/compilation (terminated|errors)/.test(line),
    )
    .join("\n");
  return { ok: run.status === 0, errors };
}

module.exports = {
  compile,
  measure,
  check,
  READS_GOOD,
  READS_CRASH,
  TOKENS_GOOD,
  TOKENS_CRASH,
};

if (require.main === module) {
  // the widget modules require "./kit/..." as they sit in an app's build (kit/tools/build.py copies kit/runtime there)
  const path = require("path"),
    Module = require("module"),
    shared = path.join(__dirname, "..", "shared") + path.sep;
  /** @type {*} */
  const loader = Module;
  const resolve = loader._resolveFilename;
  loader._resolveFilename = function (req, parent, ...rest) {
    const parentFile = parent && parent.filename ? parent.filename : "";
    if (
      parentFile.indexOf(shared) === 0 &&
      /^(\.\/|(\.\.\/)+)kit\//.test(req)
    ) {
      const kit = path.resolve(
        path.dirname(parentFile),
        req.replace(/^\.\//, ""),
      );
      const rel = path.relative(path.join(shared, "kit"), kit);
      if (!rel.startsWith(".."))
        req = path.join(__dirname, "..", "kit", "runtime", rel);
    }
    return resolve.call(this, req, parent, ...rest);
  };
  const widgets = require("../shared/widgets");
  /** @type {Record<string, string>} every widget type's shaders (its module's "shaders") */
  const all = {};
  Object.keys(widgets).forEach((type) =>
    Object.assign(all, widgets[type].shaders || {}),
  );
  let worst = "ok",
    compiler = true;
  for (const name of Object.keys(all)) {
    const result = check(all[name]);
    const built = compiler ? compile(all[name]) : { ok: true, errors: "" };
    if (built.missing) {
      compiler = false;
      console.log(
        "! glslangValidator not found (brew install glslang): shaders not compiled",
      );
    }
    const broken = !built.ok && !built.missing;
    console.log(
      (broken || result.level === "crash"
        ? "X "
        : result.level === "warn"
          ? "! "
          : "  ") +
        name.padEnd(NAME_COL) +
        result.text +
        (broken ? ", does not compile" : ""),
    );
    if (built.errors && !built.missing)
      console.log(built.errors.replace(/^/gm, "      "));
    if (broken || result.level === "crash") worst = "crash";
    else if (result.level === "warn" && worst === "ok") worst = "warn";
  }
  process.exit(worst === "crash" ? 1 : 0);
}
