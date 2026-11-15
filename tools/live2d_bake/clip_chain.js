"use strict";
/**
 * The close-up's turn (close.turnPoses) or lean (close.lean.poses) for the bake config from a VTube Studio clip
 * (vts_record.js): one stretch of the clip each way, from her rest just before she moves to where she ends up,
 * as `--steps` poses each way. Each pose is the config's params at rest plus how far each parameter moved from
 * the stretch's start, kept in its parameter's range (a recording swings past the model's ±30 deg); the steps are
 * spaced evenly along the path her head takes (its turn, nod and tilt together), so a fast start and a slow
 * settle get the same number of steps per degree. The parameters are the config's current chain's, plus --add
 * (e.g. the body's angles, when the clip moves them). The config is written with the new chain; all else kept.
 * RetrynowMiku's first turn and lean, remade this way, come within about 1 deg of the hand-made ones.
 *
 *   node tools/live2d_bake/clip_chain.js turn|lean <clip.json> <left from> <left to> <right from> <right to>
 *       <bake config.json> <out config.json> [--steps 10] [--add ParamBodyAngleX,ParamBodyAngleY,ParamBodyAngleZ]
 *
 * Times in seconds. "left" is her turning or leaning left (the chain's negative side), "right" the positive.
 */
const fs = require("fs");

const PATH = ["ParamAngleX", "ParamAngleY", "ParamAngleZ"]; // what the steps are spaced along
const SAMPLE_S = 0.005; // the path is followed this finely
const ROUND = 1000; // 3 decimals

const args = process.argv.slice(2);
/** @type {(name: string) => ?string} */
const opt = (name) => {
  const i = args.indexOf("--" + name);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const stepsOpt = opt("steps"),
  addOpt = opt("add");
const [kind, clipPath, l0, l1, r0, r1, cfgPath, outPath] = args;
if (!outPath || (kind !== "turn" && kind !== "lean")) {
  console.error(
    "usage: node tools/live2d_bake/clip_chain.js turn|lean <clip.json> <left from> <left to> <right from> <right to> " +
      "<bake config.json> <out config.json> [--steps N] [--add Param,...]",
  );
  process.exit(2);
}
const clip = JSON.parse(fs.readFileSync(clipPath, "utf8"));
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const close = cfg.close || (cfg.close = {});
const current = kind === "turn" ? close.turnPoses : close.lean && close.lean.poses;
const steps = stepsOpt ? Math.round(Number(stepsOpt)) : current ? current.length / 2 : kind === "turn" ? 10 : 19;
if (!(steps >= 1)) throw new Error("--steps: a whole number above 0");
const frames = clip.frames.map((/** @type {{ t: number, v: number[] }} */ f) => ({ t: f.t / 1000, v: f.v }));
const index = new Map(clip.names.map((/** @type {string} */ n, /** @type {number} */ i) => [n, i]));
const keys = Object.keys((current && current[0]) || {})
  .concat(addOpt ? addOpt.split(",") : [])
  .concat(PATH)
  .filter((k, i, all) => all.indexOf(k) === i && index.has(k));
const rest = cfg.params || {};

/** @type {(t: number, k: string) => number} the clip's value at t, between its two nearest frames */
const at = (t, k) => {
  const i = index.get(k);
  let j = 1;
  while (j < frames.length - 1 && frames[j].t < t) j++;
  const a = frames[j - 1],
    b = frames[j],
    f = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  return a.v[i] + (b.v[i] - a.v[i]) * f;
};
/** @type {(k: string, v: number) => number} */
const clamp = (k, v) => {
  const r = clip.params[k];
  return r ? Math.max(r.min, Math.min(r.max, v)) : v;
};

/**
 * One side: `steps` poses from the stretch's start (left out: that's upright) to its end, evenly along the path.
 * @param {number} t0
 * @param {number} t1
 * @returns {Record<string, number>[]}
 */
function side(t0, t1) {
  if (!(t1 > t0) || t0 < frames[0].t || t1 > frames[frames.length - 1].t)
    throw new Error("the stretch " + t0 + ".." + t1 + " s isn't inside the clip's " + frames[0].t + ".." + frames[frames.length - 1].t + " s");
  /** @type {(t: number, k: string) => number} */
  const value = (t, k) => clamp(k, (k in rest ? rest[k] : 0) + at(t, k) - at(t0, k));
  const ts = [],
    lengths = [0];
  for (let t = t0; t <= t1 + 1e-9; t += SAMPLE_S) ts.push(Math.min(t, t1));
  let prev = PATH.map((k) => value(ts[0], k));
  for (let i = 1; i < ts.length; i++) {
    const p = PATH.map((k) => value(ts[i], k));
    lengths.push(lengths[i - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]));
    prev = p;
  }
  const total = lengths[lengths.length - 1];
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const want = (total * s) / steps;
    let j = 0;
    while (j < lengths.length - 1 && lengths[j] < want - 1e-9) j++;
    /** @type {Record<string, number>} */
    const pose = {};
    keys.forEach((k) => {
      pose[k] = Math.round(value(ts[j], k) * ROUND) / ROUND;
    });
    out.push(pose);
  }
  return out;
}

const left = side(Number(l0), Number(l1)),
  right = side(Number(r0), Number(r1));
// the chain runs from a full left to a full right, upright left out
const poses = left.slice().reverse().concat(right);
if (kind === "turn") {
  close.turnPoses = poses;
  close.turnSteps = steps;
} else {
  close.lean = Object.assign({}, close.lean, { poses });
}
fs.writeFileSync(outPath, JSON.stringify(cfg, null, 1) + "\n");
/** @type {(p: Record<string, number>) => string} */
const angles = (p) => PATH.map((k) => (p[k] || 0).toFixed(1)).join("/");
console.log(
  outPath + ": " + kind + " " + steps + " steps each way from " + clipPath.split("/").pop() + " (left " + l0 + ".." + l1 +
    " s, right " + r0 + ".." + r1 + " s), " + keys.length + " parameters; full left " + angles(poses[0]) + ", full right " +
    angles(poses[poses.length - 1]) + " (head X/Y/Z deg)",
);
