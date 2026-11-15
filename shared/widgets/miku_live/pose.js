"use strict";
/**
 * Live Miku's pose: her Cubism parameter values from the Miku bake's config (the same file tools/live2d_bake bakes
 * the close-up from) and the drive state the widget works out, as the baked close-up's shader (miku/miku_only.glsl)
 * picks its frames, but blended smoothly instead of between baked steps:
 *   - her rest: the model's defaults with the config's "params" on top (her eyes' gaze and openness);
 *   - driving, the lean (close.lean.poses: a full lean left .. right, the upright middle left out);
 *   - stopped or an indicator on, the expressions (close.expressions, e.g. Blush and Yandere) and close.params
 *     coming on, her idle loop (close.idle: poses over its period) and the turn toward the indicator (close.turnPoses);
 *   - while she holds a turn, its hold loop on top (close.turnHold.left / .right: offsets from the full turn, as the
 *     recording moved while held, e.g. her head bobbing), scaled by how far she's turned;
 *   - her eyes shut by the blink's closure on top.
 * Each pose set is the model's rest plus the recording's movement, so each adds its offset from the rest.
 */

/** @typedef {Record<string, number>} Values parameter id -> value */
/** @typedef {{ steps: number, poses: Values[] }} Chain poses from a full -1 to a full 1, the upright 0 left out */
/** @typedef {{ id: string, value: number, blend: string }} ExprParam */
/** @typedef {{ period: number, poses: Values[] }} Loop poses evenly over its period, round and round */
/**
 * @typedef {object} Rig
 * @property {Values} rest
 * @property {?Chain} lean
 * @property {?Chain} turn
 * @property {?{ period: number, poses: Values[] }} idle
 * @property {?{ left: ?Loop, right: ?Loop }} hold the turn's hold loops (offsets), each way
 * @property {ExprParam[][]} expressions
 * @property {Values} closeParams
 * @property {string[]} eyes the eye openness parameters the blink shuts
 * @property {string[]} keys every parameter the rig sets
 */
/**
 * @typedef {object} Drive
 * @property {number} lean -1 (braking) .. 1 (pulling away)
 * @property {number} turn -1 .. 1, toward the indicator
 * @property {number} y the expressions coming on, 0 .. 1 (eased)
 * @property {number} idleT seconds into the idle loop
 * @property {number} idleW how much of the idle shows, 0 .. 1
 * @property {number} [holdT] seconds she's held the turn (its hold loop's clock)
 * @property {Values} [extra] offsets added on top of the poses (the widget's wander and breathing while she drives)
 * @property {number} closure her eyes, 0 open .. 1 shut
 */

const EYES = ["ParamEyeLOpen", "ParamEyeROpen"];

/**
 * @param {*} v
 * @returns {v is Values}
 */
function isValues(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => typeof v[k] === "number");
}

/**
 * A chain of poses, or null when there is none or it isn't one.
 * @param {*} poses
 * @returns {?Chain}
 */
function chainOf(poses) {
  if (!Array.isArray(poses) || poses.length < 2 || poses.length % 2 || !poses.every(isValues)) return null;
  return { steps: poses.length / 2, poses };
}

/**
 * An expression file's parameters (.exp3.json: Parameters [{ Id, Value, Blend: Add | Multiply | Overwrite }]).
 * @param {*} exp
 * @returns {ExprParam[]}
 */
function expressionOf(exp) {
  const list = exp && Array.isArray(exp.Parameters) ? exp.Parameters : [];
  return list
    .filter((p) => p && typeof p.Id === "string" && typeof p.Value === "number")
    .map((p) => ({ id: p.Id, value: p.Value, blend: p.Blend === "Multiply" || p.Blend === "Overwrite" ? p.Blend : "Add" }));
}

/**
 * The rig from the bake config, its expression files (file name -> parsed JSON) and the model's defaults.
 * @param {*} config
 * @param {Record<string, *>} expressionFiles
 * @param {Values} defaults
 * @returns {Rig}
 */
function rigOf(config, expressionFiles, defaults) {
  const close = (config && config.close) || {};
  const rest = Object.assign({}, defaults, isValues(config && config.params) ? config.params : {});
  const lean = chainOf(close.lean && close.lean.poses);
  const turn = chainOf(close.turnPoses);
  const idle =
    close.idle && close.idle.period > 0 && Array.isArray(close.idle.poses) && close.idle.poses.length && close.idle.poses.every(isValues)
      ? { period: close.idle.period, poses: close.idle.poses }
      : null;
  /** @type {(l: *) => ?Loop} */
  const loopOf = (l) => (l && l.period > 0 && Array.isArray(l.poses) && l.poses.length && l.poses.every(isValues) ? { period: l.period, poses: l.poses } : null);
  const hold = close.turnHold ? { left: loopOf(close.turnHold.left), right: loopOf(close.turnHold.right) } : null;
  const expressions = (Array.isArray(close.expressions) ? close.expressions : []).map((f) => expressionOf(expressionFiles[f]));
  const closeParams = isValues(close.params) ? close.params : {};
  /** @type {Set<string>} */
  const keys = new Set(Object.keys(isValues(config && config.params) ? config.params : {}));
  /** @type {(v: Values) => void} */
  const add = (v) => Object.keys(v).forEach((k) => keys.add(k));
  [lean, turn, idle, hold && hold.left, hold && hold.right].forEach((set) => set && set.poses.forEach(add));
  expressions.forEach((e) => e.forEach((p) => keys.add(p.id)));
  add(closeParams);
  EYES.forEach((k) => keys.add(k));
  // only parameters the model has (a pose from another model's recording names some it hasn't)
  const known = Array.from(keys).filter((k) => k in defaults);
  return { rest, lean, turn, idle, hold, expressions, closeParams, eyes: EYES.filter((k) => k in defaults), keys: known };
}

/**
 * @param {number} v
 * @returns {number}
 */
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

/**
 * A chain's pose at k (-1 .. 1), blended between its two nearest, as offsets from the rest, added into out.
 * @param {Chain} chain
 * @param {number} k
 * @param {Values} rest
 * @param {Values} out
 * @param {number} weight
 */
function addChain(chain, k, rest, out, weight) {
  const n = chain.steps;
  let x = clamp1(k) * n,
    i0 = Math.floor(x);
  if (i0 >= n) i0 = n - 1;
  if (i0 < -n) i0 = -n;
  const f = x - i0;
  /** @type {(j: number) => ?Values} */
  const poseAt = (j) => (j === 0 ? null : j < 0 ? chain.poses[j + n] : chain.poses[n + j - 1]);
  const a = poseAt(i0),
    b = poseAt(i0 + 1);
  /** @type {Set<string>} */
  const ids = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
  ids.forEach((id) => {
    if (!(id in out)) return;
    const r = rest[id],
      va = a && id in a ? a[id] : r,
      vb = b && id in b ? b[id] : r;
    out[id] += (va + (vb - va) * f - r) * weight;
  });
}

/**
 * The idle loop's pose at t seconds, blended between its two nearest, as offsets from the rest, added into out.
 * @param {{ period: number, poses: Values[] }} idle
 * @param {number} t
 * @param {Values} rest
 * @param {Values} out
 * @param {number} weight
 */
function addIdle(idle, t, rest, out, weight) {
  const n = idle.poses.length,
    k = ((((t % idle.period) + idle.period) % idle.period) / idle.period) * n,
    i0 = Math.min(Math.floor(k), n - 1),
    f = k - i0,
    a = idle.poses[i0],
    b = idle.poses[(i0 + 1) % n];
  Object.keys(a).forEach((id) => {
    if (!(id in out)) return;
    const r = rest[id],
      vb = id in b ? b[id] : r;
    out[id] += (a[id] + (vb - a[id]) * f - r) * weight;
  });
}

/**
 * A loop of offsets at t seconds, blended between its two nearest poses, added into out times weight.
 * @param {Loop} loop
 * @param {number} t
 * @param {Values} out
 * @param {number} weight
 */
function addLoop(loop, t, out, weight) {
  const n = loop.poses.length,
    k = ((((t % loop.period) + loop.period) % loop.period) / loop.period) * n,
    i0 = Math.min(Math.floor(k), n - 1),
    f = k - i0,
    a = loop.poses[i0],
    b = loop.poses[(i0 + 1) % n];
  Object.keys(a).forEach((id) => {
    if (!(id in out)) return;
    const vb = id in b ? b[id] : 0;
    out[id] += (a[id] + (vb - a[id]) * f) * weight;
  });
}

/**
 * Every parameter the rig sets, for the drive state now.
 * @param {Rig} rig
 * @param {Drive} d
 * @returns {Values}
 */
function compose(rig, d) {
  /** @type {Values} */
  const v = {};
  rig.keys.forEach((k) => {
    v[k] = rig.rest[k];
  });
  if (rig.lean && Math.abs(d.lean) > 1e-4) addChain(rig.lean, d.lean, rig.rest, v, 1);
  const turned = rig.turn ? Math.min(1, Math.abs(d.turn) * rig.turn.steps) : 0;
  if (rig.idle && d.idleW > 0) addIdle(rig.idle, d.idleT, rig.rest, v, d.idleW * (1 - turned));
  if (rig.turn && Math.abs(d.turn) > 1e-4) {
    addChain(rig.turn, d.turn, rig.rest, v, 1);
    // held, as the recording moved while held: fading in with the turn, so it starts and ends with it
    const loop = rig.hold && (d.turn < 0 ? rig.hold.left : rig.hold.right);
    if (loop) addLoop(loop, d.holdT || 0, v, Math.min(1, Math.abs(d.turn)));
  }
  if (d.extra)
    Object.keys(d.extra).forEach((id) => {
      if (id in v) v[id] += d.extra[id];
    });
  const y = Math.max(0, Math.min(1, d.y));
  if (y > 0) {
    Object.keys(rig.closeParams).forEach((id) => {
      if (id in v) v[id] += (rig.closeParams[id] - rig.rest[id]) * y;
    });
    rig.expressions.forEach((e) =>
      e.forEach((p) => {
        if (!(p.id in v)) return;
        if (p.blend === "Multiply") v[p.id] *= 1 + (p.value - 1) * y;
        else if (p.blend === "Overwrite") v[p.id] += (p.value - v[p.id]) * y;
        else v[p.id] += p.value * y;
      }),
    );
  }
  const open = 1 - Math.max(0, Math.min(1, d.closure));
  rig.eyes.forEach((k) => {
    v[k] *= open;
  });
  return v;
}

/**
 * "Id=value ..." for the values that moved more than eps since sent (all of them when sent is empty), and sent
 * brought up to date.
 * @param {Values} values
 * @param {Values} sent
 * @param {number} eps
 * @returns {string}
 */
function changes(values, sent, eps) {
  /** @type {string[]} */
  const out = [];
  Object.keys(values).forEach((id) => {
    const v = Math.round(values[id] * 1000) / 1000;
    if (id in sent && Math.abs(sent[id] - v) < eps) return;
    sent[id] = v;
    out.push(id + "=" + v);
  });
  return out.join(" ");
}

/**
 * The model's defaults from live2d-render's "opened" reply ("Id=value ...").
 * @param {string} list
 * @returns {Values}
 */
function parseValues(list) {
  /** @type {Values} */
  const out = {};
  String(list || "")
    .split(/[\s,]+/)
    .forEach((kv) => {
      const eq = kv.indexOf("=");
      if (eq <= 0) return;
      const v = Number(kv.slice(eq + 1));
      if (isFinite(v)) out[kv.slice(0, eq)] = v;
    });
  return out;
}

module.exports = { rigOf, compose, changes, parseValues, expressionOf };
