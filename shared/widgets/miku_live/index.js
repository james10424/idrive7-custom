"use strict";
/**
 * The "miku_live" widget: Miku drawn live with Live2D (the Miku Live2D layout). live2d-render (native/live2d-render)
 * draws her model on the head unit's GPU as a video layer of its own; this widget runs her as the baked close-up
 * does (../miku: the lean with the car, the expressions and her idle loop when stopped, the turn toward the
 * indicator, the recorded blink) and sends her Cubism parameter values (pose.js) from the same bake config.
 */
const fs = require("fs");
const path = require("path");
const { isNum } = require("../../engine/util");
const { eyeClosure, blinkOf, MIKU_BLINK_MS } = require("../miku/blink");
const { rigOf, compose, changes, parseValues } = require("./pose");
const { Live2dClient } = require("./live2d_client");
const hudData = require("../../hud_data");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} MikuLiveState
 * @property {*} [config] the bake config (data/miku-live/config.json)
 * @property {Record<string, *>} [exprFiles] its expression files, by name
 * @property {?import("./live2d_client").Live2dClient} [live]
 * @property {?import("./pose").Rig} [rig] once live2d-render has opened the model (its defaults are the rest)
 * @property {Record<string, number>} [sent] the values live2d-render has
 * @property {string} [layer] the video layer's state, from cluster-render
 * @property {number} [statsAt] when stats were last logged (ms)
 * @property {number} [lean] eased -1..1
 * @property {number} [gLatAvg] the lateral g eased over LEAN_LAT_TAU_MS, raw (the jolt's reference)
 * @property {number} [jolt] the lateral jolt, -1..1 (left +), eased
 * @property {number} [leanLat] the lateral g from its dead zone (0) to LEAN_LAT_G (1), eased -1..1 (left turn +)
 * @property {number} [point] -1..1, the head's turn toward the indicator (a spring)
 * @property {number} [pointV]
 * @property {number} [zoom] 0..1, linear: the expressions coming on
 * @property {number} [zoomT] where the zoom is going, 0 or 1
 * @property {number} [stillMs] how long the car has stood still
 * @property {number} [turnWas] the turn's target last update (-1, 0, 1)
 * @property {number} [idleMs] how far into the idle loop she is (ms)
 * @property {number} [idleAt] when idleMs last went on (ms)
 * @property {number} [holdMs] how long she's held a turn (the hold loop's clock; 0 back upright)
 * @property {number[]} [wanderPhase] the wander's random phases (WANDER's three waves each, radians)
 * @property {number[]} [bobPhase] the bob's random phases (BOB's three waves)
 * @property {number} [bobY] px she's moved down in her picture by the bob
 * @property {number} [pitchG] the longitudinal g, eased (the flight path vector's g part)
 * @property {number} [pitchRoad] the road's slope, deg, eased
 * @property {number} [pitchDeg] the flight path vector's height, deg (nose up +)
 * @property {number[]} [windPh] the flutter's wave phases, rad
 * @property {number[]} [gustPh] the gusts' phases, rad
 * @property {{ x: number, y: number }} [wind] the wind now
 * @property {?{ x: number, y: number }} [windSent] the wind live2d-render has
 * @property {boolean} [noWind] live2d-render is older than 0.1.11 (no "wind")
 * @property {boolean} [windParamsSent] the wind's parameters (the pose file's "wind") went with a "wind" since the open
 * @property {number} [bobSent] the offset live2d-render has
 * @property {boolean} [noOffset] live2d-render is older than 0.1.1 (no "offset"): no bob
 * @property {number} [glanceN] the glances she's started in this turn hold
 * @property {number} [blinkAt] when her last blink started (ms)
 * @property {number} [blinkNext] when her next blink is due (ms)
 * @property {?{ rate: number, closure: number[] }} [blink] the bake's recorded blink
 */

const DOCS = `no layer of ours: live2d-render (native/live2d-render, its Cubism SDK copied to the car by hand) draws
Miku's Live2D model live as its own video layer at the widget's rect, and this widget sends her parameter values.
Her poses, expressions, idle loop and blink come from "pose", a pose file bundled in hud/ (made from the Miku bake's
config by tools/live2d_bake/live_pose.js), or from a bake config in the app's data folder in its place
(miku-live/config.json, scripts/deploy.sh --miku-live-config); "model" is the .model3.json on the car (an absolute
path, its textures shrunk to 1024 px: scripts/deploy.sh --miku-live), "params" fixed values ("Id=value ..."),
"hide" parts left out (else the pose file's), "frame" [cx, cy, height] in model units (else its close.centre and
close.height), "fps" (else the Miku Live2D frame rate setting, 20), "core" (else the Miku Live2D Cubism updates setting, 3: Cubism Core every third frame, the frames between blended; 2 every other; 1 every frame). Without live2d-render or her model nothing is drawn and the status row says why`;

// as the baked close-up's (../miku/index.js), so she moves the same
const LIVE_FPS = 20; // her frame rate unless the layout's "fps" or the liveFps setting says otherwise
const LIVE_CORE = 3; // Cubism Core every 3rd frame, the frames between blended, unless the layout's "core" or the liveCore setting says otherwise
const LEAN_TAU_MS = 250; // her lean eases toward the g this smoothly
const LEAN_G = 0.4; // this longitudinal g is a full lean
const LEAN_DEAD_G = 0.02;
const LEAN_K = 4; // her lean eases out: 1 - e^(-k x) of a full lean at x of LEAN_G (0.1 g: 64%, 0.2 g: 88%), so
// everyday pulls lean her well and hard ones add little
// Cornering rolls her head (ParamAngleZ, added on top of the lean's, the turn's and the wander's), thrown outward as
// a passenger: a left turn (gLat +) the way braking rolls it (-, the lean chain's braking end has ParamAngleZ -16.7),
// LEAN_LAT_ROLL_DEG at LEAN_LAT_G of lateral g, straight from the dead zone up to it. The model's physics leans and
// twists her body from the head's roll. 0.1.62 and 0.1.63 turned ParamBodyAngleX instead, which physics rewrites
// every frame from her head (all the body angles are physics outputs), so it never showed. Small bumps and lane wobble are
// left out: nothing under LEAN_LAT_DEAD_G, and the g eased over LEAN_LAT_TAU_MS so short spikes average away. It
// counts only while moving, from none at STILL_KMH to all at LEAN_LAT_FULL_KMH (parked, the g's noise twitched her)
const LEAN_LAT_G = 0.15;
const LEAN_LAT_ROLL_DEG = 5;
const LEAN_LAT_DEAD_G = 0.06;
const LEAN_LAT_TAU_MS = 600;
const LEAN_LAT_FULL_KMH = 10;
// A short lateral spike (a speed bump or pothole tipping the car, which the eased corner lean averages away) jolts
// her head's roll too, the same way: the lateral g's departure from its own LEAN_LAT_TAU_MS average, past
// JOLT_G, up to JOLT_ROLL_DEG at JOLT_G + JOLT_SPAN_G; it comes on within JOLT_ATTACK_MS and springs back over
// JOLT_RELEASE_MS (about half a second to all but gone). Highway wobble under JOLT_G stays out; only while moving
const JOLT_G = 0.1;
const JOLT_SPAN_G = 0.1;
const JOLT_ROLL_DEG = 5;
const JOLT_ATTACK_MS = 40;
const JOLT_RELEASE_MS = 180;
// Wind on her hair and ribbons (live2d-render 0.1.11's "wind": Cubism's physics wind, gravity 1 down): air from the
// front, which a flat model can't push back, so a flutter (quick left-right gusts around nothing, three mixed waves)
// and a little lift. None under WIND_START_KMH, all of it at WIND_FULL_KMH (the square root between, so town has a
// breeze); the flutter quickens from WIND_HZ[0] to WIND_HZ[1] with it, and slow gusts swell it (WIND_GUST_HZ).
// Sent when it moves WIND_SEND or more
const WIND_START_KMH = 5;
const WIND_FULL_KMH = 120;
const WIND_FLUTTER = 1.2;
const WIND_LIFT = 0.35;
const WIND_HZ = [0.6, 1.6];
const WIND_MIX = [[1, 0.55], [1.73, 0.3], [2.61, 0.15]]; // [frequency ratio, weight]
const WIND_GUST_HZ = [0.13, 0.07];
const WIND_SEND = 0.01;
const LEAN_SOFT = 1.15; // the faces' scale, as the lean's before (tanh gain): they still come on at the same g
const POINT_K = 70; // the head turn's spring (1/s^2): about 1.3 Hz
const POINT_C = 16.7; // critically damped
const POINT_STEP_S = 0.01;
const STILL_MS = 1000; // stood still this long: the expressions come on
const STILL_KMH = 0.5;
const ZOOM_OUT_KMH = 10; // past this they go off
const IN_MS = 500; // the expressions coming on or going off
const TURN_BACK = 0.01; // her head this near straight counts as back from a turn
const MAX_DT_MS = 500;
const SEND_EPS = 0.002; // a value moving less than this isn't sent
const STATS_LOG_MS = 60000;
// While she isn't idling (driving: the idle loop plays only with the expressions on), a small wander so she isn't
// still between leans: each parameter [amplitude, base Hz] a mix of three slow waves (the base, 1.73 and 2.91
// times it, weights WANDER_MIX) with random phases, so it never repeats. Offsets from her pose, faded out as her
// idle comes in.
const WANDER = {
  ParamAngleX: [3, 0.13],
  ParamAngleY: [2, 0.17],
  ParamAngleZ: [2, 0.11],
  ParamBodyAngleX: [1.5, 0.07],
  ParamBodyAngleZ: [1, 0.09],
  ParamEyeBallX: [0.1, 0.23],
  ParamEyeBallY: [0.06, 0.19],
};
const WANDER_MIX = [0.6, 0.3, 0.1];
const WANDER_RATIO = [1, 1.73, 2.91];
const BREATH_HZ = 0.25; // and breathing (the idle loop breathes when she's stopped)
// And while her idle loop isn't playing (driving, or turned), her whole figure bobs up and down in her picture
// (live2d-render's "offset"), as if riding along: [amplitude px, base Hz], the same mix of three waves with random
// phases, faded out as her idle comes in
const BOB = [3, 0.21];
const BOB_NOD = 10; // and her head nods with it: down this many degrees (ParamAngleY) at the bob's full dip
const BOB_BODY = 5; // and her body bends forward with it (ParamBodyAngleY), degrees at the full dip
const BOB_SEND_PX = 0.1; // an offset moving less than this isn't sent
// and she rides the F-16 layout's flight path vector up and down (widgets/f16): the road's slope (LaneSlope) plus
// PITCH_G_DEG a g of longitudinal acceleration (nose up pulling away, down braking): her head tilts with the nose
// (ParamAngleY) a degree a degree, at most PITCH_HEAD_MAX, and her body half as much (ParamBodyAngleY), at most
// PITCH_BODY_MAX; the g eased over PITCH_G_TAU_MS past PITCH_G_DEAD, the slope over PITCH_SLOPE_TAU_MS while it's
// fresher than PITCH_SLOPE_FRESH_MS (as the F-16 layout eases them)
const PITCH_G_DEG = 12;
const PITCH_HEAD_MAX = 10;
const PITCH_BODY_MAX = 5;
const PITCH_G_TAU_MS = 350;
const PITCH_G_DEAD = 0.02;
const PITCH_SLOPE_TAU_MS = 300; // quicker than the F-16's 1.5 s: the car's slope is already smooth, its 0.1 % flicker is ~0.06 deg of head
const PITCH_SLOPE_FRESH_MS = 3000;
// Holding a turn, she looks along it GLANCE_AWAY_MS, then glances back at you: her eyes swing to the side opposite
// her turned head (GLANCE_X of their range) and to her rest height, hold, and go back to the turn, GLANCE_MS in all,
// easing GLANCE_EASE_MS each way; and again. She blinks as each glance starts. Her head stays turned.
const GLANCE_AWAY_MS = 4000;
const GLANCE_MS = 2000;
const GLANCE_EASE_MS = 120;
const GLANCE_X = 0.8;

/**
 * The wander and breathing at t seconds, times weight: offsets for compose's "extra".
 * @param {number[]} phase WANDER's three waves each
 * @param {number} t
 * @param {number} weight
 * @returns {Record<string, number>}
 */
function wander(phase, t, weight) {
  /** @type {Record<string, number>} */
  const out = {};
  Object.keys(WANDER).forEach((k, i) => {
    const [amp, hz] = WANDER[k];
    let v = 0;
    for (let w = 0; w < WANDER_MIX.length; w++)
      v += WANDER_MIX[w] * Math.sin(2 * Math.PI * hz * WANDER_RATIO[w] * t + phase[i * WANDER_MIX.length + w]);
    out[k] = amp * v * weight;
  });
  out.ParamBreath = (0.5 - 0.5 * Math.cos(2 * Math.PI * BREATH_HZ * t)) * weight;
  return out;
}

/**
 * The bob at t seconds, times weight: px down in her picture.
 * @param {number[]} phase BOB's three waves
 * @param {number} t
 * @param {number} weight
 * @returns {number}
 */
function bob(phase, t, weight) {
  let v = 0;
  for (let w = 0; w < WANDER_MIX.length; w++) v += WANDER_MIX[w] * Math.sin(2 * Math.PI * BOB[1] * WANDER_RATIO[w] * t + phase[w]);
  return BOB[0] * v * weight;
}

/**
 * The glance's weight holding a turn for holdMs: 0 looking along the turn, 1 looking back at you.
 * @param {number} holdMs
 * @returns {number}
 */
function glanceWeight(holdMs) {
  const into = holdMs % (GLANCE_AWAY_MS + GLANCE_MS) - GLANCE_AWAY_MS;
  if (into < 0) return 0;
  return smooth01(Math.min(into, GLANCE_MS - into) / GLANCE_EASE_MS);
}

/**
 * @param {number} x
 * @returns {number}
 */
const smooth01 = (x) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};

/**
 * Her poses: the pose file bundled with the app (the widget's "pose", in hud/: tools/live2d_bake/live_pose.js, its
 * expressions written in), or a bake config in the app's data folder in its place, for trying one out
 * (miku-live/config.json and its .exp3.json files: scripts/deploy.sh --miku-live-config). Throws with what's missing.
 * @param {HudApp} hud
 * @param {Widget} widget
 * @returns {{ config: *, exprFiles: Record<string, *>, from: string }}
 */
function loadFiles(hud, widget) {
  const dir = path.join(hud.ctx.dataDir || ".", "miku-live"),
    file = path.join(dir, "config.json");
  if (fs.existsSync(file)) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!config || !config.close) throw new Error("miku-live/config.json has no close-up (close)");
    /** @type {Record<string, *>} */
    const exprFiles = {};
    (config.close.expressions || []).forEach((/** @type {string} */ f) => {
      const p = path.join(dir, path.basename(f));
      if (!fs.existsSync(p)) throw new Error("no miku-live/" + path.basename(f) + " (scripts/deploy.sh --miku-live-config)");
      exprFiles[f] = JSON.parse(fs.readFileSync(p, "utf8"));
    });
    return { config, exprFiles, from: "data/miku-live/config.json" };
  }
  const rel = typeof widget.pose === "string" ? widget.pose : "";
  const config = rel ? hudData.json(rel) : {};
  if (!config || !config.close) throw new Error(rel ? "no poses in " + rel : '"pose": the pose file in hud/');
  return { config, exprFiles: config.expressions || {}, from: rel };
}

/**
 * The status row's problem, or none.
 * @param {HudApp} hud
 * @param {?string} text
 */
function problem(hud, text) {
  const p = text ? "Miku Live2D: " + text : null;
  if (hud.problem === p) return;
  if (p) hud.log.warn(p);
  hud.problem = p;
  hud._status();
}

/**
 * Her frame rate: the layout's "fps", else the liveFps setting (10, 15, 20, 24 or 30; a change reopens her), else 20.
 * @param {HudApp} hud
 * @param {Widget} w
 * @returns {number}
 */
function fpsOf(hud, w) {
  const fps = Number(w.fps || hud.setting("liveFps") || LIVE_FPS);
  return Math.max(1, Math.min(30, isFinite(fps) ? Math.round(fps) : LIVE_FPS));
}

/**
 * How often Cubism Core runs: the layout's "core", else the liveCore setting (1 every frame, 2 every other, 3 every
 * third; the frames between blend her vertices; a change reopens her), else 3.
 * @param {HudApp} hud
 * @param {Widget} w
 * @returns {number}
 */
function coreOf(hud, w) {
  const core = Number(w.core || hud.setting("liveCore") || LIVE_CORE);
  return Math.max(1, Math.min(3, isFinite(core) ? Math.round(core) : LIVE_CORE));
}

/**
 * live2d-render's open: the model, where her picture goes, how it is framed, her first values.
 * @param {HudApp} hud
 * @param {WidgetState & MikuLiveState} state
 * @returns {Record<string, string | number | boolean>}
 */
function openMessage(hud, state) {
  const w = state.w,
    close = state.config.close,
    frame = Array.isArray(w.frame) && w.frame.length === 3 ? w.frame : [(close.centre || [0, 0])[0], (close.centre || [0, 0])[1], close.height || 1],
    hide = Array.isArray(w.hide) ? w.hide : state.config.hide || [];
  return {
    t: "open",
    model: String(w.model),
    w: Math.floor(w.w / 4) * 4,
    h: Math.floor(w.h / 2) * 2,
    fps: fpsOf(hud, w),
    core: coreOf(hud, w),
    target: hud.target,
    x: w.x,
    y: w.y,
    z: w.z || 0,
    frame: frame.join(" "),
    hide: hide.join(","),
    v: typeof w.params === "string" ? w.params : "",
    visible: true,
  };
}

/**
 * Her drive state now: the baked close-up's timings (../miku/index.js update, close-up only), each part free of the others.
 * @param {HudApp} hud
 * @param {WidgetState & MikuLiveState} state
 * @param {number} now
 * @returns {import("./pose").Drive}
 */
function drive(hud, state, now) {
  const data = hud.car.data(),
    dt = state.at ? Math.min(MAX_DT_MS, now - state.at) : 0;
  state.at = now;
  // the lean, the turn, the idle and the expressions are each blended on their own (pose.js adds them), so unlike
  // the baked close-up, which showed one baked frame at a time, she leans whenever the g pulls (expressions on or
  // not) and turns toward the indicator from wherever she is: leaning, mid-way into the expressions, idling
  // the g's noise taken off (parked it reads +-0.01..0.02 g; nothing under LEAN_DEAD_G, no jump past it), as the
  // steep start of her lean would sway her with it
  const gl = isNum(data.gLong) ? Math.sign(data.gLong) * Math.max(0, Math.abs(data.gLong) - LEAN_DEAD_G) : 0;
  const leanTarget = Math.max(-LEAN_G, Math.min(LEAN_G, gl)) / LEAN_G;
  state.lean = isNum(state.lean) ? state.lean + (leanTarget - state.lean) * (1 - Math.exp(-dt / LEAN_TAU_MS)) : leanTarget;
  const glat = isNum(data.gLat) ? Math.sign(data.gLat) * Math.max(0, Math.abs(data.gLat) - LEAN_LAT_DEAD_G) : 0;
  const latKmh = hud._raw("speed"),
    moving = isNum(latKmh) ? Math.max(0, Math.min(1, (latKmh - STILL_KMH) / (LEAN_LAT_FULL_KMH - STILL_KMH))) : 0;
  const latSpan = LEAN_LAT_G - LEAN_LAT_DEAD_G,
    latTarget = (moving * Math.max(-latSpan, Math.min(latSpan, glat))) / latSpan;
  state.leanLat = isNum(state.leanLat)
    ? state.leanLat + (latTarget - state.leanLat) * (1 - Math.exp(-dt / LEAN_LAT_TAU_MS))
    : latTarget;
  // the jolt: how far the lateral g just left its own average, past JOLT_G
  const gLatNow = isNum(data.gLat) ? data.gLat : 0;
  state.gLatAvg = isNum(state.gLatAvg) ? state.gLatAvg + (gLatNow - state.gLatAvg) * (1 - Math.exp(-dt / LEAN_LAT_TAU_MS)) : gLatNow;
  const off = gLatNow - state.gLatAvg,
    joltTo = moving * Math.sign(off) * Math.min(1, Math.max(0, Math.abs(off) - JOLT_G) / JOLT_SPAN_G),
    jolt = isNum(state.jolt) ? state.jolt : 0,
    rising = Math.abs(joltTo) > Math.abs(jolt) || Math.sign(joltTo) * Math.sign(jolt) < 0;
  state.jolt = jolt + (joltTo - jolt) * (1 - Math.exp(-dt / (rising ? JOLT_ATTACK_MS : JOLT_RELEASE_MS)));
  // the wind from the front: a flutter quickening and a lift growing with speed, swelled by slow gusts
  const windK = isNum(latKmh) ? Math.sqrt(Math.max(0, Math.min(1, (latKmh - WIND_START_KMH) / (WIND_FULL_KMH - WIND_START_KMH)))) : 0;
  if (!state.windPh) state.windPh = WIND_MIX.map(() => Math.random() * 2 * Math.PI);
  if (!state.gustPh) state.gustPh = WIND_GUST_HZ.map(() => Math.random() * 2 * Math.PI);
  const hz = WIND_HZ[0] + (WIND_HZ[1] - WIND_HZ[0]) * windK,
    sec = Math.min(dt, 200) / 1000;
  let flutter = 0;
  WIND_MIX.forEach((w, i) => {
    state.windPh[i] = (state.windPh[i] + 2 * Math.PI * hz * w[0] * sec) % (2 * Math.PI);
    flutter += w[1] * Math.sin(state.windPh[i]);
  });
  let gust = 0;
  WIND_GUST_HZ.forEach((f, i) => {
    state.gustPh[i] = (state.gustPh[i] + 2 * Math.PI * f * sec) % (2 * Math.PI);
    gust += Math.sin(state.gustPh[i]);
  });
  gust = 0.75 + 0.25 * (gust / WIND_GUST_HZ.length); // 0.5 .. 1
  state.wind = { x: windK * WIND_FLUTTER * gust * flutter, y: windK * WIND_LIFT * gust };
  const turnSide = hud._turnSide();
  // she blinks as her head starts to turn, away or back, as in the turn recording
  if (isNum(state.turnWas) && turnSide !== state.turnWas) {
    state.blinkAt = now;
    state.blinkNext = now + MIKU_BLINK_MS[0] + Math.random() * (MIKU_BLINK_MS[1] - MIKU_BLINK_MS[0]);
  }
  state.turnWas = turnSide;
  if (!isNum(state.point) || !isNum(state.pointV)) {
    state.point = turnSide;
    state.pointV = 0;
  }
  for (let left = dt / 1000; left > 0; left -= POINT_STEP_S) {
    const s = Math.min(POINT_STEP_S, left);
    state.pointV += (POINT_K * (turnSide - state.point) - POINT_C * state.pointV) * s;
    state.point = Math.max(-1, Math.min(1, state.point + state.pointV * s));
  }
  // while turned, the hold loop's clock (it starts with the turn, at the loop's start, so it joins smoothly)
  state.holdMs = Math.abs(state.point || 0) > TURN_BACK ? (state.holdMs || 0) + dt : 0;
  // holding the turn (the indicator still on), she glances back at you, blinking as each glance starts
  const glancing = turnSide !== 0 && state.holdMs >= GLANCE_AWAY_MS;
  const glanceN = glancing ? Math.floor((state.holdMs - GLANCE_AWAY_MS) / (GLANCE_AWAY_MS + GLANCE_MS)) + 1 : 0;
  if (glanceN > (state.glanceN || 0)) {
    state.blinkAt = now;
    state.blinkNext = now + MIKU_BLINK_MS[0] + Math.random() * (MIKU_BLINK_MS[1] - MIKU_BLINK_MS[0]);
  }
  state.glanceN = glanceN;
  const glanceW = glancing ? glanceWeight(state.holdMs) * Math.min(1, Math.abs(state.point || 0)) : 0;
  // the expressions: on after standing still STILL_MS, or with an indicator; off past ZOOM_OUT_KMH. They go off as
  // the indicator does, while her head turns back, as they come on with it
  const speed = hud._raw("speed"),
    still = isNum(speed) && speed < STILL_KMH;
  state.stillMs = still ? (state.stillMs || 0) + dt : 0;
  if (hud._turnSide()) state.zoomT = 1;
  else if (!isNum(speed) || speed > ZOOM_OUT_KMH) state.zoomT = 0;
  else if (state.stillMs >= STILL_MS) state.zoomT = 1;
  const zoom = isNum(state.zoom) ? state.zoom : 0,
    move = dt / IN_MS;
  state.zoom = state.zoomT > zoom ? Math.min(state.zoomT, zoom + move) : Math.max(state.zoomT || 0, zoom - move);
  const y = smooth01(state.zoom);
  // her idle loop: from its start as the expressions finish coming on; back to its start while her head is turned
  const turned = Math.abs(state.point || 0),
    firstStep = 1 / Math.max(1, (state.rig && state.rig.turn && state.rig.turn.steps) || 1);
  if (state.zoomT === 1 && state.zoom < 1) state.idleMs = 0;
  else if (turned > firstStep) state.idleMs = 0;
  else if (turned <= TURN_BACK) state.idleMs = (state.idleMs || 0) + (now - (state.idleAt || now));
  state.idleAt = now;
  // no blink while the expressions come on or go off (the baked in-steps have none)
  const closure = y > 0.001 && y < 0.999 ? 0 : eyeClosure(state, now);
  if (!state.wanderPhase) {
    state.wanderPhase = [];
    for (let i = 0; i < Object.keys(WANDER).length * WANDER_MIX.length; i++) state.wanderPhase.push(Math.random() * 2 * Math.PI);
  }
  if (!state.bobPhase) state.bobPhase = WANDER_MIX.map(() => Math.random() * 2 * Math.PI);
  // faded out as her idle loop comes in: it plays only with the expressions on and her head not turned (pose.js)
  const idleShown = y * (1 - Math.min(1, turned * Math.max(1, (state.rig && state.rig.turn && state.rig.turn.steps) || 1)));
  state.bobY = bob(state.bobPhase, now / 1000, 1 - idleShown);
  // the flight path vector's height: the road's slope plus the g's pitch, eased (deg, nose up +)
  const gDead = isNum(data.gLong) ? Math.sign(data.gLong) * Math.max(0, Math.abs(data.gLong) - PITCH_G_DEAD) : 0,
    slopeTo = now - (hud.slopeAt || 0) < PITCH_SLOPE_FRESH_MS && isNum(hud.slopePitch) ? hud.slopePitch : 0;
  state.pitchG = isNum(state.pitchG) ? state.pitchG + (gDead - state.pitchG) * (1 - Math.exp(-dt / PITCH_G_TAU_MS)) : gDead;
  state.pitchRoad = isNum(state.pitchRoad)
    ? state.pitchRoad + (slopeTo - state.pitchRoad) * (1 - Math.exp(-dt / PITCH_SLOPE_TAU_MS))
    : slopeTo;
  state.pitchDeg = state.pitchRoad + state.pitchG * PITCH_G_DEG;
  const extra = wander(state.wanderPhase, now / 1000, 1 - y);
  extra.ParamAngleY = (extra.ParamAngleY || 0) - (BOB_NOD * state.bobY) / BOB[0];   // her head dips as she does
  extra.ParamBodyAngleY = (extra.ParamBodyAngleY || 0) - (BOB_BODY * state.bobY) / BOB[0];   // and her body bends
  // the flight path vector's height tilts her head and body with the nose
  const clampDeg = (/** @type {number} */ v, /** @type {number} */ max) => Math.max(-max, Math.min(max, v));
  extra.ParamAngleY += clampDeg(state.pitchDeg, PITCH_HEAD_MAX);
  extra.ParamBodyAngleY += clampDeg(state.pitchDeg / 2, PITCH_BODY_MAX);
  // cornering rolls her head outward, her body after it through the model's physics
  extra.ParamAngleZ = (extra.ParamAngleZ || 0) - (state.leanLat || 0) * LEAN_LAT_ROLL_DEG - (state.jolt || 0) * JOLT_ROLL_DEG;
  return {
    extra,
    lean: Math.sign(state.lean) * (1 - Math.exp(-LEAN_K * Math.abs(state.lean))) / (1 - Math.exp(-LEAN_K)),
    faceLean: Math.tanh(state.lean * LEAN_SOFT) / Math.tanh(LEAN_SOFT),
    turn: state.point,
    y,
    idleT: (state.idleMs || 0) / 1000,
    idleW: y,
    holdT: (state.holdMs || 0) / 1000,
    glance: glanceW > 0 ? { w: glanceW, x: -GLANCE_X * Math.sign(turnSide) } : undefined,
    closure,
  };
}

module.exports = {
  type: "miku_live",
  fields: ["model", "pose"],
  external: true,
  docs: DOCS,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & MikuLiveState} state
   */
  create(hud, widget, state) {
    try {
      const files = loadFiles(hud, widget);
      hud.log.info("miku live2d: poses from " + files.from);
      state.config = files.config;
      state.exprFiles = files.exprFiles;
    } catch (err) {
      problem(hud, err instanceof Error ? err.message : String(err));
      return;
    }
    if (typeof widget.model !== "string" || widget.model[0] !== "/") {
      problem(hud, '"model": the .model3.json on the car, an absolute path');
      return;
    }
    state.blink = blinkOf(state.config.close);
    state.rig = null;
    state.sent = {};
    const live = new Live2dClient();
    state.live = live;
    live.on("connect", () => {
      state.rig = null;
      state.sent = {};
      state.noOffset = false;
      state.bobSent = 0;
      state.noWind = false;
      state.windSent = null;
      state.windParamsSent = false;
      live.send(openMessage(hud, state));
    });
    live.on("opened", (/** @type {*} */ m) => {
      state.rig = rigOf(state.config, state.exprFiles || {}, parseValues(m.defaults));
      // a new model starts calm, with the wind on all of its physics: both told again
      state.windSent = null;
      state.windParamsSent = false;
      hud.log.info("miku live2d: opened in " + m.ms + " ms (" + m.gl + "), " + state.rig.keys.length + " of " + m.params + " parameters driven");
      if (m.unknown || m.missing_parts) hud.log.warn("miku live2d: the model hasn't " + [m.unknown, m.missing_parts].filter(Boolean).join(", "));
      problem(hud, null);
      hud._update(state, Date.now(), true);
    });
    live.on("error", (/** @type {*} */ m) => {
      // live2d-render before 0.1.11 doesn't know "wind": her hair hangs as before
      if (/"wind"/.test(String(m.reason))) {
        if (!state.noWind) hud.log.info("miku live2d: live2d-render takes no wind (older than 0.1.11)");
        state.noWind = true;
        return;
      }
      // live2d-render 0.1.0 doesn't know "offset": no bob, and nothing wrong otherwise
      if (/"offset"/.test(String(m.reason))) {
        if (!state.noOffset) hud.log.info("miku live2d: live2d-render takes no offsets (older than 0.1.1): no bob");
        state.noOffset = true;
        return;
      }
      problem(hud, (m.op === "open" ? "" : m.op + ": ") + m.reason);
    });
    live.on("layer", (/** @type {*} */ m) => {
      if (m.state !== state.layer) hud.log.info("miku live2d: layer " + m.state + (m.reason ? " (" + m.reason + ")" : ""));
      state.layer = m.state;
    });
    live.on("stats", (/** @type {*} */ m) => {
      const now = Date.now();
      if (state.statsAt && now - state.statsAt < STATS_LOG_MS) return;
      state.statsAt = now;
      hud.log.info("miku live2d: " + m.fps + " fps, update " + m.update + " ms, draw " + m.draw + " ms, " + m.busy + "% of a frame");
    });
    live.on("disconnect", () => {
      state.rig = null;
      problem(hud, "live2d-render stopped");
    });
    // not connected after a while: say why (not installed, not running)
    setTimeout(() => {
      if (state.live === live && !live.connected && live.why) problem(hud, live.why);
    }, 4000);
    state.timer = setInterval(
      () =>
        hud._guard("widget " + widget.id, () => {
          if (hud._freshData) hud._freshData();
          hud._update(state, Date.now(), false);
        }),
      // her pose goes out once a frame
      Math.round(1000 / fpsOf(hud, widget)),
    );
  },
  /**
   * Her drive state and the parameter values that changed, to live2d-render. Never hidden from here: her video layer
   * is live2d-render's own, and cluster-render hides it whenever BMW takes the HUD. (The app's own target state, which
   * other widgets go by, says nothing here: this layout has no layer of the app's, so its target never shows, and
   * 0.1.41/0.1.42 kept her hidden on the car for good.)
   * @param {HudApp} hud
   * @param {WidgetState & MikuLiveState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const live = state.live;
    if (!live || !live.connected || !state.rig) return;
    const values = compose(state.rig, drive(hud, state, now));
    if (force) state.sent = {};
    const list = changes(values, state.sent || (state.sent = {}), SEND_EPS);
    if (list) live.send({ t: "p", v: list });
    // her bob, when live2d-render takes offsets (0.1.1 on)
    const y = Math.round((state.bobY || 0) * 10) / 10;
    if (!state.noOffset && (force || Math.abs(y - (state.bobSent || 0)) >= BOB_SEND_PX)) {
      state.bobSent = y;
      live.send({ t: "offset", x: 0, y });
    }
    // the wind on her hair, when live2d-render takes it (0.1.11 on; it keeps it until told again)
    const w = state.wind || { x: 0, y: 0 },
      ws = state.windSent;
    if (!state.noWind && (force || !ws || Math.abs(w.x - ws.x) >= WIND_SEND || Math.abs(w.y - ws.y) >= WIND_SEND)) {
      state.windSent = { x: w.x, y: w.y };
      /** @type {Record<string, string | number | boolean>} */
      const msg = { t: "wind", x: Math.round(w.x * 1000) / 1000, y: Math.round(w.y * 1000) / 1000 };
      // the first since the open names the parameters it moves (her hair, ribbons, lace), so her body stays calm
      const params = state.config && Array.isArray(state.config.wind) ? state.config.wind : [];
      if (!state.windParamsSent && params.length) {
        msg.params = params.join(",");
        state.windParamsSent = true;
      }
      live.send(msg);
    }
  },
  /**
   * Back to upright, the expressions off ("reset" settings).
   * @param {HudApp} hud
   * @param {WidgetState & MikuLiveState} state
   */
  reset(hud, state) {
    state.lean = 0;
    state.point = 0;
    state.pointV = 0;
    state.zoom = 0;
    state.zoomT = 0;
    state.stillMs = 0;
    state.idleMs = 0;
    state.at = Date.now();
  },
  /**
   * The layout is going: the connection closes, and live2d-render lets her model go.
   * @param {HudApp} hud
   * @param {WidgetState & MikuLiveState} state
   */
  gone(hud, state) {
    if (state.live) state.live.close();
    state.live = null;
  },
  /** for tests (pose_test.js, tools): her drive state and the open message */
  test: { drive, openMessage, glanceWeight, bob },
};
