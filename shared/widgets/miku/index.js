"use strict";
/**
 * The "miku" widget: the Miku layout's standing character, an effect layer.
 */
const { isNum } = require("../../engine/util");
const MIKU = require("./shader");
const { sprite } = require("./sprite");
const { idle } = require("./idle");

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} MikuState
 * @property {number} [lean] eased -1..1
 * @property {number} [spd] eased 0..1
 * @property {number} [point] -1..1
 * @property {number} [pointV]
 * @property {number} [look] glance -1..1
 * @property {number} [lookV]
 * @property {number} [lookT] the glance's target
 * @property {number} [lookUntil] ms
 * @property {number} [lookN] glance frames
 * @property {number} [doze] 0..1
 * @property {number} [dozeV]
 * @property {number} [dozeN] doze frames
 * @property {number} [idleMs]
 * @property {number} [stillMs]
 * @property {boolean} [wokeUp]
 * @property {string} [lastI] the last u_idle key
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the Miku layout's standing character, from frames baked offline
(tools/live2d_bake) and kept in the app's data folder (miku/, see sprite.js); animated by the renderer's
clock (time: true), so only a small u_drive uniform goes up when the smoothed g or the speed moves a step.
"feet" [x, y] target px where the bake's "anchor" (between her feet) goes ([480, 377]). Nothing is drawn
without frames (the status row says so)`;

const MIKU_MS = 16; // the Miku character's own update rate (60 Hz)
const MIKU_TAU_MS = 450; // the Miku character's speed follows the car this smoothly
const MIKU_LEAN_TAU_MS = 250; // her lean eases toward the g this smoothly (no spring: no sway back past upright)
const MIKU_POINT_K = 70; // the pointing arm's spring (1/s^2): about 1.3 Hz
const MIKU_POINT_C = 16.7; // critically damped: it rises and settles without bouncing

/**
 * The Miku shader for a widget and the "Miku parts" setting: leaving the glances and dozing, or (bare) everything
 * but the lean out of the shader altogether, to find what a display can't take. The layout's "idle": false does the
 * same as noIdle.
 * @param {Widget} widget
 * @param {string} parts the "Miku parts" setting
 * @returns {string} the fragment shader
 */
function mikuShader(widget, parts) {
  const noIdle =
    widget.idle === false || parts === "noIdle" || parts === "bare";
  return (
    (noIdle ? "#define MIKU_NO_IDLE\n" : "") +
    (parts === "bare" ? "#define MIKU_BARE\n" : "") +
    MIKU
  );
}

module.exports = {
  type: "miku",
  fields: [],
  docs: DOCS,
  time: true,
  /** The shader to draw her with, or null (the reason logged) when her frames are missing or bad.
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {number} connIndex connection index
   * @returns {?string}
   */
  shader(hud, widget, connIndex) {
    if (!sprite(hud, widget, connIndex)) return null;
    return mikuShader(widget, hud.setting("mikuParts"));
  },
  /** For tools/shader_budget.js: every shader the "Miku parts" setting can pick.
   * @type {Record<string, string>} */
  shaders: {
    miku: MIKU,
    "miku (no idle)": "#define MIKU_NO_IDLE\n" + MIKU,
    "miku (bare)": "#define MIKU_NO_IDLE\n#define MIKU_BARE\n" + MIKU,
  },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & MikuState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref;
    // the bake's "anchor" (frame px, between her feet) goes on the widget's "feet" point
    const atlas = sprite(hud, widget, state.ci),
      info = atlas.info,
      feet =
        Array.isArray(widget.feet) && widget.feet.length === 2
          ? widget.feet
          : [480, 377];
    /** @type {(k: string) => number[]} */
    const frameRect = (k) =>
      (info.frames && info.frames[k]) || info.frames.idle;
    /** @type {(part: *) => number[]} */
    const rect = (part) =>
      part && Array.isArray(part.rect) ? part.rect : [0, 0, 0, 0];
    client.bind(ref, "u_atlas", atlas.ref);
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_atlasSize", atlas.size);
    client.uniform(ref, "u_frame", info.frame);
    client.uniform(ref, "u_origin", [
      feet[0] - widget.x - info.anchor[0],
      feet[1] - widget.y - info.anchor[1],
    ]);
    // the fixed sprite values go up as three vec4 arrays (u_spr: the eye frames, the tails, the crop and the
    // tables' counts; u_arm), which shader.js names back with #define; the per-frame tables (lean,
    // glance and doze frames, head and hip shifts) are pixel rows under the atlas (_sprite, mikuData). Few
    // uniforms: the cluster's GPU restarted on the 0.1.9 .. 0.1.12 shader's 55 uniform vectors (or its size)
    const spr = frameRect("idle").concat(
      frameRect("half"),
      frameRect("shut"),
      frameRect("talk"),
    );
    const arms = Array.isArray(info.arms) ? info.arms.slice(0, 2) : [],
      /** @type {(vec: *) => number[]} */
      padVec = (vec) =>
        Array.isArray(vec)
          ? [vec[0] || 0, vec[1] || 0, vec[2] || 0, 0]
          : [0, 0, 0, 0];
    const armF = [];
    [0, 1].forEach((i) => {
      const arm = arms[i];
      armF.push(
        ...(arm ? arm.rect : [0, 0, 0, 0]),
        ...(arm
          ? [arm.at[0], arm.at[1], arm.shoulder[0], arm.shoulder[1]]
          : [0, 0, 0, 0]),
        ...padVec(arm && arm.left),
        ...padVec(arm && arm.right),
      );
    });
    client.uniform(ref, "u_arm", armF, { type: "vec4" });
    client.uniform(ref, "u_armSide", [
      arms[0] ? arms[0].side : -1,
      arms[1] ? arms[1].side : 1,
      ((isNum(widget.point) ? widget.point : 60) * Math.PI) / 180,
      // the arms balance a sideways lean only: leaning toward or away from you they just ride along
      info.leanAxis === "fb"
        ? 0
        : ((isNum(widget.balance) ? widget.balance : 50) * Math.PI) / 180,
    ]);
    state.lookN = atlas.counts.look;
    state.dozeN = atlas.counts.doze;
    client.uniform(ref, "u_idle", [0, 0, 0, 0]);
    client.uniform(ref, "u_hip", [
      info.hipY,
      isNum(info.headY) ? info.headY : 0,
      info.breathe === false ? 0 : 1,
      0,
    ]);
    // her lean on its own 60 Hz timer, not the 20 Hz tick: the shader draws at the display's rate, and a lean that
    // moved only every third frame would step. A message goes up only when the lean or speed changes a step
    state.timer = setInterval(
      () =>
        hud._guard("widget " + widget.id, () =>
          hud._update(state, Date.now(), false),
        ),
      MIKU_MS,
    );
    const tails = info.tails || null;
    // u_spr[4]: the rect the face, glance and doze frames are crops of (none: an older bake's whole frames)
    const crop =
      Array.isArray(info.crop) && info.crop.length === 4
        ? info.crop
        : [0, 0, 0, 0];
    client.uniform(
      ref,
      "u_spr",
      spr.concat(
        rect(tails),
        tails
          ? [
              tails.at[0],
              tails.at[1],
              tails.rootY || 0,
              tails.length || tails.rect[3],
            ]
          : [0, 0, 0, 1],
        crop,
        [atlas.counts.lean, atlas.counts.look, atlas.counts.doze, atlas.dataY],
      ),
      { type: "vec4" },
    );
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & MikuState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    // lean: the longitudinal g, -0.4 g .. +0.4 g to -1 .. 1, eased over MIKU_LEAN_TAU_MS; speed 0..130 km/h to
    // 0..1, eased over MIKU_TAU_MS; both sent in steps of 0.002 (a small uniform message, at most one per MIKU_MS, and only while she moves)
    const data = hud.car.data(),
      dt = state.at ? Math.min(500, now - state.at) : 0;
    state.at = now;
    // standing on a bus: the lean eases toward the g (as Unreal's FInterpTo, but 1 - exp(-dt / tau), the same at
    // any update rate), so she leans into a pull and straightens when it ends, without swaying back past upright;
    // the ease also smooths the car's steppy, noisy g
    const leanTarget = isNum(data.gLong)
      ? Math.max(-0.4, Math.min(0.4, data.gLong)) / 0.4
      : 0;
    state.lean = isNum(state.lean)
      ? state.lean +
        (leanTarget - state.lean) * (1 - Math.exp(-dt / MIKU_LEAN_TAU_MS))
      : leanTarget;
    // pointing: toward the indicator ('L' -1, 'R' 1, hazards or none 0), on a quicker spring (about 1.3 Hz, no
    // overshoot) so the arm rises and falls smoothly
    const turnSide = hud._turnSide(),
      dtp = dt / 1000;
    if (!isNum(state.point)) {
      state.point = turnSide;
      state.pointV = 0;
    }
    for (let left = dtp; left > 0; left -= 0.01) {
      const stepSec = Math.min(0.01, left);
      state.pointV +=
        (MIKU_POINT_K * (turnSide - state.point) -
          MIKU_POINT_C * state.pointV) *
        stepSec;
      state.point = Math.max(
        -1,
        Math.min(1, state.point + state.pointV * stepSec),
      );
    }
    const speed = hud._raw("speed"),
      speedFrac = isNum(speed) ? Math.min(1, Math.max(0, speed / 130)) : 0,
      /** @type {(value: number) => number} */
      step = (value) => Math.round(value * 500) / 500;
    idle(state, now, dt, data.gLong, speed);
    state.spd = isNum(state.spd)
      ? state.spd + (speedFrac - state.spd) * (1 - Math.exp(-dt / MIKU_TAU_MS))
      : speedFrac;
    // a soft limit: past a full lean the spring's swing eases into it instead of stopping dead
    const drive = [
      step(Math.tanh(state.lean * 1.15)),
      step(state.spd),
      step(state.point),
      hud.themeName === "night" ? 0.8 : 1,
    ];
    const idleVals = [step(state.look), step(state.doze), 0, 0];
    const key = drive.join("|"),
      keyI = idleVals.join("|");
    if (force || keyI !== state.lastI) {
      state.lastI = keyI;
      state.c.uniform(state.ref, "u_idle", idleVals);
    }
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_drive", drive);
  },
};
