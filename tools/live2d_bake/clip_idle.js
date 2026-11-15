"use strict";
/**
 * An idle loop for the bake config (close.idle: { period, poses }) from a VTube Studio clip (vts_record.js): the
 * part of it between two times, as the config's params at rest plus how far each parameter moved from its value
 * at the start, sampled into evenly spaced poses, with what is left over at the end (the drift) taken off evenly
 * along the loop so its end meets its start, and each value kept in its parameter's range. Only the parameters the
 * config's current idle poses carry (the head, the eyes' gaze, breath, hair and twin tails: not the eyes' openness,
 * so a blink in the clip doesn't come along; the app blinks her on its own), or --keys. The config is written
 * with the new loop; everything else in it is kept.
 *
 *   node tools/live2d_bake/clip_idle.js <clip.json> <from s> <to s> <bake config.json> <out config.json>
 *       [--poses 80] [--speed 1.151]
 *
 * --speed: the loop plays this much faster than recorded (RetrynowMiku's: 5.18 s of clip over 4.5 s); --poses: up
 * to 80 (the bake's idle atlases hold 80).
 */
const fs = require("fs");

const DEFAULT_POSES = 80;
const DEFAULT_SPEED = 5.18 / 4.5; // the first idle loop's, kept for the next ones
const ROUND = 1000; // 3 decimals

const args = process.argv.slice(2);
/** @type {(name: string, def: number) => number} */
const opt = (name, def) => {
  const i = args.indexOf("--" + name);
  if (i < 0) return def;
  const v = Number(args.splice(i, 2)[1]);
  if (!(v > 0)) throw new Error("--" + name + ": a number above 0");
  return v;
};
const poses = Math.round(opt("poses", DEFAULT_POSES)),
  speed = opt("speed", DEFAULT_SPEED);
const [clipPath, fromS, toS, cfgPath, outPath] = args;
if (!outPath) {
  console.error("usage: node tools/live2d_bake/clip_idle.js <clip.json> <from s> <to s> <bake config.json> <out config.json> [--poses 80] [--speed 1.151]");
  process.exit(2);
}
const clip = JSON.parse(fs.readFileSync(clipPath, "utf8"));
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const t0 = Number(fromS),
  t1 = Number(toS);
const frames = clip.frames.map((/** @type {{ t: number, v: number[] }} */ f) => ({ t: f.t / 1000, v: f.v }));
if (!(t1 > t0) || t0 < frames[0].t || t1 > frames[frames.length - 1].t)
  throw new Error("the loop " + t0 + ".." + t1 + " s isn't inside the clip's " + frames[0].t + ".." + frames[frames.length - 1].t + " s");
const index = new Map(clip.names.map((/** @type {string} */ n, /** @type {number} */ i) => [n, i]));
const old = cfg.close && cfg.close.idle && cfg.close.idle.poses;
const keys = Object.keys((old && old[0]) || {}).filter((k) => index.has(k));
if (!keys.length) throw new Error("the config's idle poses name no parameter the clip has");
const rest = Object.assign({}, cfg.params || {});

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

const out = [];
for (let n = 0; n < poses; n++) {
  const frac = n / poses,
    t = t0 + (t1 - t0) * frac;
  /** @type {Record<string, number>} */
  const pose = {};
  keys.forEach((k) => {
    const base = k in rest ? rest[k] : 0; // at rest: the config's params, else the parameter's default, 0
    const drift = at(t1, k) - at(t0, k);
    pose[k] = Math.round(clamp(k, base + at(t, k) - at(t0, k) - drift * frac) * ROUND) / ROUND;
  });
  out.push(pose);
}
const period = Math.round(((t1 - t0) / speed) * ROUND) / ROUND;
cfg.close.idle = Object.assign({}, cfg.close.idle, { period, poses: out });
fs.writeFileSync(outPath, JSON.stringify(cfg, null, 1) + "\n");
console.log(
  outPath + ": idle " + poses + " poses over " + period + " s from " + clipPath.split("/").pop() + " " + t0 + ".." + t1 + " s (" +
    keys.length + " parameters; the drift taken off: " +
    keys
      .map((k) => [k, at(t1, k) - at(t0, k)])
      .filter((kd) => Math.abs(Number(kd[1])) > 0.5)
      .map((kd) => kd[0] + " " + Number(kd[1]).toFixed(1))
      .join(", ") + ")",
);
