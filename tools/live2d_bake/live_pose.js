"use strict";
/**
 * Live Miku's pose file, bundled with Custom HUD (apps/custom_hud/hud/miku-live/): from a close-up bake config, only
 * what the Miku Live2D layout reads (shared/widgets/miku_live/pose.js: her rest params and hidden parts, and the
 * close-up's framing, lean and its faces, turn and its hold loops, idle loop, blink and expressions), the expressions' parameters written in (from
 * their .exp3.json files next to the model), every number rounded to 3 decimals. Parameter values only: no art.
 *
 *   node tools/live2d_bake/live_pose.js <bake config.json> <model folder> <out.json>
 */
const fs = require("fs");
const path = require("path");

const [cfgPath, modelDir, outPath] = process.argv.slice(2);
if (!cfgPath || !modelDir || !outPath) {
  console.error("usage: node tools/live2d_bake/live_pose.js <bake config.json> <model folder> <out.json>");
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const close = cfg.close;
if (!close || !close.only) {
  console.error(cfgPath + ": not a close-up-only bake config (close.only)");
  process.exit(1);
}
/** @type {(v: *) => *} */
const round = (v) =>
  typeof v === "number"
    ? Math.round(v * 1000) / 1000
    : Array.isArray(v)
      ? v.map(round)
      : v && typeof v === "object"
        ? Object.keys(v).reduce((/** @type {Record<string, *>} */ o, k) => ((o[k] = round(v[k])), o), {})
        : v;
/** @type {Record<string, *>} */
const expressions = {};
(close.expressions || []).forEach((/** @type {string} */ f) => {
  const exp = JSON.parse(fs.readFileSync(path.join(modelDir, f), "utf8"));
  expressions[f] = { Parameters: (exp.Parameters || []).map((/** @type {*} */ p) => ({ Id: p.Id, Value: p.Value, Blend: p.Blend || "Add" })) };
});
const out = round({
  _about: "Miku Live2D's poses (tools/live2d_bake/live_pose.js from " + path.basename(cfgPath) + "): parameter values only",
  params: cfg.params || {},
  hide: cfg.hide || [],
  close: {
    centre: close.centre,
    height: close.height,
    params: close.params,
    expressions: close.expressions || [],
    lean: close.lean && close.lean.poses ? { poses: close.lean.poses } : undefined,
    turnPoses: close.turnPoses,
    // the standing lean's faces, from lean.face of a full lean on: Miku Live2D eases them in as she leans. Pulling
    // away, the happy face (lean.right); braking, only the braking face's mouth (lean.left's ParamMouth*: its eye
    // swap and sweat drop are on/off switches, which would fade in see-through)
    leanFace: cfg.lean && (cfg.lean.right || cfg.lean.left)
      ? {
          from: cfg.lean.face == null ? 0.6 : cfg.lean.face,
          right: cfg.lean.right,
          left: cfg.lean.left
            ? Object.keys(cfg.lean.left).filter((k) => /^ParamMouth/.test(k)).reduce((/** @type {Record<string, number>} */ o, k) => ((o[k] = cfg.lean.left[k]), o), {})
            : undefined,
        }
      : undefined,
    idle: close.idle && close.idle.poses ? { period: close.idle.period, poses: close.idle.poses } : undefined,
    turnHold: close.turnHold
      ? {
          left: close.turnHold.left && { period: close.turnHold.left.period, poses: close.turnHold.left.poses },
          right: close.turnHold.right && { period: close.turnHold.right.period, poses: close.turnHold.right.poses },
        }
      : undefined,
    blink: close.blink,
  },
  expressions,
});
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
console.log(
  outPath + ": " + Math.round(fs.statSync(outPath).size / 1024) + " KiB; lean " + ((close.lean && close.lean.poses) || []).length +
    " poses, turn " + (close.turnPoses || []).length + ", idle " + ((close.idle && close.idle.poses) || []).length + ", " +
    Object.keys(expressions).length + " expressions",
);
