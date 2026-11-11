"use strict";
/**
 * The "miku" widget: the Miku layout's standing character, over three effect layers (back, mid, front) that move as
 * one: the "mid" one runs her and sends every layer the same pose in the same tick.
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
 * @property {string} [lastS] the last u_step key
 * @property {number} [fall] the side she has toppled to (-1 left, 1 right), 0 standing
 * @property {number} [gait] 0 .. 2 x shuffles: how far she has stumbled
 * @property {number} [gaitTo] where the gait is going: 2 x shuffles to the wall, 0 back to her spot
 * @property {number} [stride] px a shuffle, signed the way she goes
 * @property {number} [holdMs] how long the lean has been full
 * @property {number} [press] 0..1 pressed against the wall
 * @property {Record<string, number[]>} [sent] the pose uniforms last sent, for a layer made later
 * @property {{ left: number, right: number }} [reach] her body's reach at a full lean (frame px from the anchor)
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the Miku layout's standing character, from frames baked offline
(tools/live2d_bake) and kept in the app's data folder (miku/, see sprite.js); animated by the renderer's
clock (time: true), so only small pose uniforms go up when the smoothed g or the speed moves a step.
"part": "back" (tails and legs), "mid" (the body; the default) or "front" (the arms): one widget per part, the same
rect and fields, in that order, so each layer's shader stays under the cluster's limits; the mid one runs her and
sends all of them the same pose. "feet" [x, y] target px where the bake's "anchor" (between her feet) goes ([480,
377]). A full lean held topples her: "walls" [x left, x right] target px she stumbles to ([355, 605]), "steps" the
shuffles she takes (2: the foot on that side steps out, the other follows, twice); the rect must reach the walls. Nothing is drawn without frames (the status row says so)`;

const MIKU_MS = 16; // the Miku character's own update rate (60 Hz)
const MIKU_TAU_MS = 450; // the Miku character's speed follows the car this smoothly
const MIKU_LEAN_TAU_MS = 250; // her lean eases toward the g this smoothly (no spring: no sway back past upright)
const MIKU_POINT_K = 70; // the pointing arm's spring (1/s^2): about 1.3 Hz
const MIKU_POINT_C = 16.7; // critically damped: it rises and settles without bouncing
const MIKU_TOPPLE_AT = 0.95; // her eased lean (0..1) at which she starts losing her balance
const MIKU_TOPPLE_MS = 300; // ... held this long, she topples
const MIKU_RECOVER_BELOW = 0.5; // pressed against the wall until the lean eases under this, then she walks back
const MIKU_STUMBLE_MS = 130; // one foot's step stumbling to the wall
const MIKU_RETURN_MS = 260; // one foot's step walking back
const MIKU_PRESS_TAU_MS = 90; // how quickly she presses into the wall when she reaches it
const MIKU_WALL_GAP = 2; // px her body stops short of the wall
/** The parts and what each defines in the shader (shader.js). */
const PARTS = {
  back: "#define MIKU_BACK\n",
  mid: "#define MIKU_MID\n",
  front: "#define MIKU_FRONT\n",
};

/**
 * Which part a widget draws.
 * @param {Widget} widget
 * @returns {"back" | "mid" | "front"}
 */
function partOf(widget) {
  return widget.part === "back" || widget.part === "front"
    ? widget.part
    : "mid";
}

/**
 * The Miku widgets of the layout now, the mid one first (it runs her; the others take its pose).
 * @param {HudApp} hud
 * @returns {WidgetState[]}
 */
function members(hud) {
  /** @type {WidgetState[]} */
  const all = [];
  hud.widgets.forEach((state) => {
    if (state.w.type === "miku") all.push(state);
  });
  return all;
}

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
    PARTS[partOf(widget)] +
    (noIdle ? "#define MIKU_NO_IDLE\n" : "") +
    (parts === "bare" ? "#define MIKU_BARE\n" : "") +
    MIKU
  );
}

/** For tools/shader_budget.js: every shader a layer can be. @type {Record<string, string>} */
const SHADERS = {};
Object.keys(PARTS).forEach((part) => {
  const define = PARTS[/** @type {keyof PARTS} */ (part)];
  SHADERS["miku " + part] = define + MIKU;
  SHADERS["miku " + part + " (no idle)"] =
    define + "#define MIKU_NO_IDLE\n" + MIKU;
  SHADERS["miku " + part + " (bare)"] =
    define + "#define MIKU_NO_IDLE\n#define MIKU_BARE\n" + MIKU;
});

/**
 * Her reach at a full lean each way with the arms: the body's (sprite.js) or the near arm's hand, as the front
 * layer's shader poses it there (carried and turned by the lean, swung out a third of the balance), whichever is
 * further. Frame px from the anchor.
 * @param {{ left: number, right: number }} body
 * @param {Array<Record<string, *>>} arms the bake's arms
 * @param {number[]} anchor
 * @param {number} balance rad, the far arm's swing at a full lean
 * @returns {{ left: number, right: number }}
 */
function reachWithArms(body, arms, anchor, balance) {
  const reach = { left: body.left, right: body.right },
    lean = Math.tanh(1.15); // the lean the shader gets at a full g (update's soft limit)
  arms.forEach((arm) => {
    if (!arm || !Array.isArray(arm.rect) || !Array.isArray(arm.at)) return;
    [-1, 1].forEach((way) => {
      const off = way < 0 ? arm.left : arm.right;
      if (!Array.isArray(off)) return;
      const near = arm.side === way,
        phi = off[2] * lean - arm.side * balance * lean * (near ? 0.33 : 1),
        cos = Math.cos(phi),
        sin = Math.sin(phi),
        [sx, sy] = arm.shoulder;
      [0, arm.rect[2]].forEach((dx) =>
        [0, arm.rect[3]].forEach((dy) => {
          const qx = arm.at[0] + dx - sx,
            qy = arm.at[1] + dy - sy,
            x = sx + off[0] * lean + cos * qx - sin * qy - anchor[0];
          if (way < 0) reach.left = Math.min(reach.left, x);
          else reach.right = Math.max(reach.right, x);
        }),
      );
    });
  });
  return reach;
}

/**
 * Toppling: a full lean (|lean| at MIKU_TOPPLE_AT or more) held MIKU_TOPPLE_MS topples her to that side: the gait
 * runs out to 2 x shuffles, one foot a MIKU_STUMBLE_MS, and she is pressed against the wall (press) while the lean
 * stays over MIKU_RECOVER_BELOW that way; then the gait runs back to 0, one foot a MIKU_RETURN_MS, and she stands. A
 * full lean held again on the way back topples her again; a stumble, once started, always reaches the wall.
 * @param {WidgetState & MikuState} state
 * @param {number} dt ms
 */
function topple(state, dt) {
  const widget = state.w,
    shuffles = isNum(widget.steps) && widget.steps >= 1 ? widget.steps : 2,
    out = shuffles * 2,
    lean = /** @type {number} */ (state.lean),
    side = lean < 0 ? -1 : 1;
  if (!isNum(state.gait)) {
    state.gait = 0;
    state.gaitTo = 0;
    state.fall = 0;
    state.stride = 0;
    state.holdMs = 0;
    state.press = 0;
  }
  const full = Math.abs(lean) >= MIKU_TOPPLE_AT;
  // the lean held full: toward the side she stands or has walked back from (not away from a wall she is still at)
  const canFall = !state.fall || (state.gaitTo === 0 && side === state.fall);
  state.holdMs =
    full && canFall ? /** @type {number} */ (state.holdMs) + dt : 0;
  if (/** @type {number} */ (state.holdMs) >= MIKU_TOPPLE_MS) {
    state.holdMs = 0;
    if (!state.fall) {
      // how far to the wall: from where she stands, her body's reach at a full lean, to the wall less a gap
      const feet =
          Array.isArray(widget.feet) && widget.feet.length === 2
            ? widget.feet[0]
            : 480,
        walls =
          Array.isArray(widget.walls) && widget.walls.length === 2
            ? widget.walls
            : [355, 605],
        reach = state.reach || { left: -50, right: 50 },
        travel =
          side < 0
            ? Math.min(0, walls[0] + MIKU_WALL_GAP - (feet + reach.left))
            : Math.max(0, walls[1] - MIKU_WALL_GAP - (feet + reach.right));
      state.stride = travel / shuffles;
    }
    state.fall = side;
    state.gaitTo = out;
  }
  // at the wall: pressed while the lean stays her way, then back
  if (
    state.fall &&
    state.gait === out &&
    !(side === state.fall && Math.abs(lean) >= MIKU_RECOVER_BELOW)
  )
    state.gaitTo = 0;
  const gait = /** @type {number} */ (state.gait),
    goal = /** @type {number} */ (state.gaitTo);
  if (gait < goal) state.gait = Math.min(goal, gait + dt / MIKU_STUMBLE_MS);
  else if (gait > goal) state.gait = Math.max(goal, gait - dt / MIKU_RETURN_MS);
  if (state.fall && state.gait === 0 && state.gaitTo === 0) {
    state.fall = 0;
    state.stride = 0;
  }
  const pressTo = state.fall && state.gait === out && goal === out ? 1 : 0;
  state.press =
    /** @type {number} */ (state.press) +
    (pressTo - /** @type {number} */ (state.press)) *
      (1 - Math.exp(-dt / MIKU_PRESS_TAU_MS));
  if (state.press < 0.002) state.press = 0;
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
  shaders: SHADERS,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & MikuState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      part = partOf(widget);
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
    if (part === "front") client.uniform(ref, "u_arm", armF, { type: "vec4" });
    if (part === "front")
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
    state.reach = reachWithArms(
      atlas.reach,
      arms,
      info.anchor,
      info.leanAxis === "fb"
        ? 0
        : ((isNum(widget.balance) ? widget.balance : 50) * Math.PI) / 180,
    );
    // the legs (up to 2): sprites the back layer swings and bends at the knee to step
    const legs = Array.isArray(info.legs) ? info.legs.slice(0, 2) : [],
      legF = [];
    [0, 1].forEach((i) => {
      const leg = legs[i];
      legF.push(
        ...(leg ? leg.rect : [0, 0, 0, 0]),
        ...(leg
          ? [leg.at[0], leg.at[1], leg.hip[0], leg.hip[1]]
          : [0, 0, 0, 0]),
        ...(leg
          ? [leg.knee[0], leg.knee[1], leg.ankle[0], leg.ankle[1]]
          : [0, 0, 0, 0]),
      );
    });
    if (part === "back") client.uniform(ref, "u_leg", legF, { type: "vec4" });
    client.uniform(ref, "u_idle", [0, 0, 0, 0]);
    client.uniform(ref, "u_step", [0, 0, 0, 0]);
    client.uniform(ref, "u_hip", [
      info.hipY,
      isNum(info.headY) ? info.headY : 0,
      info.breathe === false ? 0 : 1,
      0,
    ]);
    // her lean on its own 60 Hz timer, not the 20 Hz tick: the shader draws at the display's rate, and a lean that
    // moved only every third frame would step. A message goes up only when the lean or speed changes a step. The
    // back and front layers have no timer: the mid one sends them its pose
    if (partOf(widget) === "mid")
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
   * The mid layer runs her and sends every Miku layer the same pose; the back and front ones only take the last pose
   * when they are made (force).
   * @param {HudApp} hud
   * @param {WidgetState & MikuState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    if (partOf(state.w) !== "mid") {
      if (!force) return;
      /** @type {(WidgetState & MikuState) | undefined} */
      const lead = members(hud).find((other) => partOf(other.w) === "mid");
      const sent = lead && lead.sent;
      if (sent)
        Object.keys(sent).forEach((name) =>
          state.c.uniform(state.ref, name, sent[name]),
        );
      return;
    }
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
    topple(state, dt);
    // a soft limit: past a full lean the spring's swing eases into it instead of stopping dead
    const drive = [
      step(Math.tanh(state.lean * 1.15)),
      step(state.spd),
      step(state.point),
      hud.themeName === "night" ? 0.8 : 1,
    ];
    const idleVals = [step(state.look), step(state.doze), 0, 0];
    const stepVals = [
      Math.round(/** @type {number} */ (state.gait) * 100) / 100,
      Math.round(/** @type {number} */ (state.stride) * 2) / 2,
      step(/** @type {number} */ (state.press)),
      0,
    ];
    /** @type {Record<string, number[]>} */
    const changed = {};
    const keyD = drive.join("|"),
      keyI = idleVals.join("|"),
      keyS = stepVals.join("|");
    if (force || keyI !== state.lastI) changed.u_idle = idleVals;
    if (force || keyS !== state.lastS) changed.u_step = stepVals;
    if (force || keyD !== state.last) changed.u_drive = drive;
    state.lastI = keyI;
    state.lastS = keyS;
    state.last = keyD;
    const names = Object.keys(changed);
    if (!names.length) return;
    state.sent = Object.assign(state.sent || {}, changed);
    // every layer the same values in the same tick, so they move as one
    members(hud).forEach((layer) =>
      names.forEach((name) => layer.c.uniform(layer.ref, name, changed[name])),
    );
  },
};
