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
/** @typedef {InstanceType<typeof import("../../engine/app")>} HudApp */

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
 * @param {Widget} w
 * @param {string} parts the "Miku parts" setting
 * @returns {string} the fragment shader
 */
function mikuShader(w, parts) {
  const noIdle = w.idle === false || parts === "noIdle" || parts === "bare";
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
   * @param {Widget} w
   * @param {number} ci connection index
   * @returns {?string}
   */
  shader(hud, w, ci) {
    if (!sprite(hud, w, ci)) return null;
    return mikuShader(w, hud.setting("mikuParts"));
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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref;
    // the bake's "anchor" (frame px, between her feet) goes on the widget's "feet" point
    const sp = sprite(hud, w, x.ci),
      j = sp.info,
      ft = Array.isArray(w.feet) && w.feet.length === 2 ? w.feet : [480, 377];
    /** @type {(k: string) => number[]} */
    const fr = (k) => (j.frames && j.frames[k]) || j.frames.idle;
    /** @type {(o: *) => number[]} */
    const rect = (o) => (o && Array.isArray(o.rect) ? o.rect : [0, 0, 0, 0]);
    c.bind(ref, "u_atlas", sp.ref);
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_atlasSize", sp.size);
    c.uniform(ref, "u_frame", j.frame);
    c.uniform(ref, "u_origin", [
      ft[0] - w.x - j.anchor[0],
      ft[1] - w.y - j.anchor[1],
    ]);
    // the fixed sprite values go up as three vec4 arrays (u_spr: the eye frames, the tails, the crop and the
    // tables' counts; u_arm), which shader.js names back with #define; the per-frame tables (lean,
    // glance and doze frames, head and hip shifts) are pixel rows under the atlas (_sprite, mikuData). Few
    // uniforms: the cluster's GPU restarted on the 0.1.9 .. 0.1.12 shader's 55 uniform vectors (or its size)
    const spr = fr("idle").concat(fr("half"), fr("shut"), fr("talk"));
    const am = Array.isArray(j.arms) ? j.arms.slice(0, 2) : [],
      /** @type {(o: *) => number[]} */
      v3 = (o) =>
        Array.isArray(o) ? [o[0] || 0, o[1] || 0, o[2] || 0, 0] : [0, 0, 0, 0];
    const armF = [];
    [0, 1].forEach((i) => {
      const a = am[i];
      armF.push(
        ...(a ? a.rect : [0, 0, 0, 0]),
        ...(a
          ? [a.at[0], a.at[1], a.shoulder[0], a.shoulder[1]]
          : [0, 0, 0, 0]),
        ...v3(a && a.left),
        ...v3(a && a.right),
      );
    });
    c.uniform(ref, "u_arm", armF, { type: "vec4" });
    c.uniform(ref, "u_armSide", [
      am[0] ? am[0].side : -1,
      am[1] ? am[1].side : 1,
      ((isNum(w.point) ? w.point : 60) * Math.PI) / 180,
      // the arms balance a sideways lean only: leaning toward or away from you they just ride along
      j.leanAxis === "fb"
        ? 0
        : ((isNum(w.balance) ? w.balance : 50) * Math.PI) / 180,
    ]);
    x.lookN = sp.counts.look;
    x.dozeN = sp.counts.doze;
    c.uniform(ref, "u_idle", [0, 0, 0, 0]);
    c.uniform(ref, "u_hip", [
      j.hipY,
      isNum(j.headY) ? j.headY : 0,
      j.breathe === false ? 0 : 1,
      0,
    ]);
    // her lean on its own 60 Hz timer, not the 20 Hz tick: the shader draws at the display's rate, and a lean that
    // moved only every third frame would step. A message goes up only when the lean or speed changes a step
    x.timer = setInterval(
      () =>
        hud._guard("widget " + w.id, () => hud._update(x, Date.now(), false)),
      MIKU_MS,
    );
    const tl = j.tails || null;
    // u_spr[4]: the rect the face, glance and doze frames are crops of (none: an older bake's whole frames)
    const cr =
      Array.isArray(j.crop) && j.crop.length === 4 ? j.crop : [0, 0, 0, 0];
    c.uniform(
      ref,
      "u_spr",
      spr.concat(
        rect(tl),
        tl
          ? [tl.at[0], tl.at[1], tl.rootY || 0, tl.length || tl.rect[3]]
          : [0, 0, 0, 1],
        cr,
        [sp.counts.lean, sp.counts.look, sp.counts.doze, sp.dataY],
      ),
      { type: "vec4" },
    );
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    // lean: the longitudinal g, -0.4 g .. +0.4 g to -1 .. 1, eased over MIKU_LEAN_TAU_MS; speed 0..130 km/h to
    // 0..1, eased over MIKU_TAU_MS; both sent in steps of 0.002 (a small uniform message, at most one per MIKU_MS, and only while she moves)
    const d = hud.car.data(),
      dt = x.at ? Math.min(500, now - x.at) : 0;
    x.at = now;
    // standing on a bus: the lean eases toward the g (as Unreal's FInterpTo, but 1 - exp(-dt / tau), the same at
    // any update rate), so she leans into a pull and straightens when it ends, without swaying back past upright;
    // the ease also smooths the car's steppy, noisy g
    const g = isNum(d.gLong) ? Math.max(-0.4, Math.min(0.4, d.gLong)) / 0.4 : 0;
    x.lean = isNum(x.lean)
      ? x.lean + (g - x.lean) * (1 - Math.exp(-dt / MIKU_LEAN_TAU_MS))
      : g;
    // pointing: toward the indicator ('L' -1, 'R' 1, hazards or none 0), on a quicker spring (about 1.3 Hz, no
    // overshoot) so the arm rises and falls smoothly
    const tp = hud._turnSide(),
      dtp = dt / 1000;
    if (!isNum(x.point)) {
      x.point = tp;
      x.pointV = 0;
    }
    for (let left = dtp; left > 0; left -= 0.01) {
      const h = Math.min(0.01, left);
      x.pointV += (MIKU_POINT_K * (tp - x.point) - MIKU_POINT_C * x.pointV) * h;
      x.point = Math.max(-1, Math.min(1, x.point + x.pointV * h));
    }
    const v = hud._raw("speed"),
      sv = isNum(v) ? Math.min(1, Math.max(0, v / 130)) : 0,
      /** @type {(f: number) => number} */
      step = (f) => Math.round(f * 500) / 500;
    idle(x, now, dt, d.gLong, v);
    x.spd = isNum(x.spd)
      ? x.spd + (sv - x.spd) * (1 - Math.exp(-dt / MIKU_TAU_MS))
      : sv;
    // a soft limit: past a full lean the spring's swing eases into it instead of stopping dead
    const u = [
      step(Math.tanh(x.lean * 1.15)),
      step(x.spd),
      step(x.point),
      hud.themeName === "night" ? 0.8 : 1,
    ];
    const ui = [step(x.look), step(x.doze), 0, 0];
    const key = u.join("|"),
      keyI = ui.join("|");
    if (force || keyI !== x.lastI) {
      x.lastI = keyI;
      x.c.uniform(x.ref, "u_idle", ui);
    }
    if (!force && key === x.last) return;
    x.last = key;
    x.c.uniform(x.ref, "u_drive", u);
  },
};
