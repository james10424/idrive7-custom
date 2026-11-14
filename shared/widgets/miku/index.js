"use strict";
/**
 * The "miku" widget: the Miku layout's character, an effect layer standing and a second one (part "close") for the
 * close-up she zooms into when the car stops.
 */
const { isNum } = require("../../engine/util");
const { MIKU, MIKU_CLOSE, MIKU_ONLY, MIKU_NONE } = require("./shader");
const { sprite, closeSprite } = require("./sprite");

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} MikuState
 * @property {number} [lean] eased -1..1
 * @property {number} [spd] eased 0..1
 * @property {number} [point] -1..1, toward the indicator (the arm standing, the head turn in the close-up)
 * @property {number} [pointV]
 * @property {number} [zoom] 0..1, linear: the close-up's 1 s ramp
 * @property {number} [zoomT] where the zoom is going, 0 or 1
 * @property {number} [stillMs] how long the car has stood still
 * @property {number} [firstStep] the close-up's first zoom step, 0..1 of the eased zoom
 * @property {string} [lastZ] the last u_zoom key
 * @property {number[]} [zoomVals] the close-up layer's u_zoom, last sent
 * @property {number} [clockAt] when the close-up's u_clock last went up (ms)
 * @property {boolean} [blanked] (the close-up layer) told to draw nothing after a refusal
 * @property {boolean} [only] (the standing layer) her bake is close-up only: it runs her and draws nothing
 * @property {number} [shownAt] (the standing layer, close-up only) when the close-up layer was last shown (ms; 0: not shown)
 * @property {number[]} [pkSent] (the standing layer, close-up only) the close-up layer's u_pk, last sent
 * @property {number} [idleT] (the standing layer, close-up only) seconds into the idle loop, last worked out
 * @property {number[]} [turnShift] (the standing layer, close-up only) the bake's turn, then lean, head shifts (px)
 * @property {number[]} [idleShift] (the standing layer, close-up only) the idle loop's head shifts (px)
 * @property {number} [idleCount] (the standing layer, close-up only) the idle loop's frames (0: none)
 * @property {boolean} [idleSplit] (the standing layer, close-up only) its even frames in one atlas, the odd in another
 * @property {?{ rate: number, closure: number[] }} [blink] (the standing layer, close-up only) one blink, from the bake
 * @property {number} [ehSent] (the standing layer, close-up only) the close-up layer's u_eh, last sent
 * @property {number} [blinkAt] (the standing layer, close-up only) when her last blink started (ms)
 * @property {number} [blinkNext] (the standing layer, close-up only) when her next blink is due (ms)
 * @property {number} [turnWas] (the standing layer, close-up only) the turn's target last update (-1, 0, 1)
 * @property {number} [leanSteps] (the standing layer, close-up only) the bake's lean steps each way
 * @property {number} [leanStep] (the standing layer, close-up only) the lean step she's going to, -leanSteps .. leanSteps
 * @property {number} [leanEased] (the standing layer, close-up only) the lean shown, easing to leanStep's
 * @property {number} [idlePeriod] (the standing layer, close-up only) the idle loop's length, s (0: none)
 * @property {number} [idleMs] (the standing layer, close-up only) how far into the idle loop she is (ms)
 * @property {number} [idleAt] (the standing layer, close-up only) when idleMs last went on (ms)
 * @property {number} [turnSteps] (the standing layer, close-up only) the bake's turn steps each way
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the Miku layout's character, from frames baked offline (tools/live2d_bake) and kept in the
app's data folder (miku/, see sprite.js); animated by the renderer's clock (time: true), so only small uniforms go up
when the smoothed g, the speed or the zoom moves a step. Two widgets of this type, the same rect, in this order: the
first draws her standing and runs her; "part": "close" draws the close-up she zooms into when the car has stood still
for 1 s (out again past 10 km/h), from the bake's close.etc2 (none baked: she just stands). "feet" [x, y] target px
where the bake's "anchor" (between her feet) goes ([480, 377]). Nothing is drawn without frames (the status row says
so)`;

const MIKU_MS = 33; // the Miku character's own update rate (30 Hz: cluster-render draws at most 30 frames a second)
const MIKU_TAU_MS = 450; // the Miku character's speed follows the car this smoothly
const MIKU_LEAN_TAU_MS = 250; // her lean eases toward the g this smoothly (no spring: no sway back past upright)
const MIKU_POINT_K = 70; // the pointing arm's spring (1/s^2): about 1.3 Hz
const MIKU_POINT_C = 16.7; // critically damped: it rises and settles without bouncing
const MIKU_STILL_MS = 1000; // stood still (speed 0) this long: she zooms into her close-up
const MIKU_CLOCK_MS = 33; // the close-up's own clock (u_clock) goes up this often while she is zoomed in
const MIKU_ZOOM_MS = 1000; // the zoom, in or out
const MIKU_TURN_BACK = 0.01; // close-up only: her head this near straight counts as back from a turn
const MIKU_IN_MS = 500; // close-up only: the expressions coming on (Yandere's hands rising, Blush), or going off
const MIKU_ZOOM_OUT_KMH = 10; // past this she zooms back out to standing
const MIKU_STILL_KMH = 0.5; // below this she counts as stood still
const MIKU_NIGHT_BRIGHTNESS = 0.8; // she is drawn this bright in the night theme
/** @type {number[]} */
const MIKU_FEET = [480, 377]; // "feet" default, target px
const MIKU_POINT_DEG = 60; // "point" default: the arm's raise toward the indicator
const MIKU_BALANCE_DEG = 50; // "balance" default: the arms' swing against a sideways lean
const MIKU_MAX_DT_MS = 500; // a longer gap between updates eases as if it were this long
const MIKU_LEAN_G = 0.4; // this longitudinal g is a full lean
const MIKU_POINT_STEP_S = 0.01; // the arm's spring is stepped at most this long at a time
const MIKU_SPEED_KMH = 130; // her speed's full scale
const IDLE_BLEND = 0.35; // close-up only: each idle frame holds, then crossfades into the next over this much of its time
const CLOSE_TURN_SHIFT_SLOTS = 36; // the zooming close-up's turn head shifts sent (miku_close.glsl u_tsh[9])
const MIKU_STEPS = 500; // the lean, speed, zoom and turn are sent in steps of 1/500
const MIKU_LEAN_SOFT = 1.15; // the lean's soft limit (tanh gain)
const MIKU_LEAN_STEP_TAU_MS = 120; // close-up only: she eases to the lean's step this quickly
const MIKU_LEAN_SNAP = 0.002; // and is there within this of it
const MIKU_LEAN_HYST = 0.75; // close-up only: the lean's step changes this far (in steps) past it, not halfway
const MIKU_SETTLE_MS = 3000; // close-up only: her idle loop waits this long after her layer is (back) on the HUD
const MIKU_CLOCK_LOOP_MS = 4000; // the close-up's u_clock runs 0 .. 4 s, then starts again
const MIKU_BLINK_OPEN = 0.05; // close-up only: a recorded blink is over once her eyes are less shut than this
const MIKU_BLINK_MS = [3000, 5000]; // close-up only: a blink this far apart (at random between), and as her head turns

/**
 * Whether a widget is the close-up's layer.
 * @param {Widget} widget
 * @returns {boolean}
 */
const isClose = (widget) => widget.part === "close";
/**
 * Whether her bake is close-up only (atlas.json close.only): the close-up layer draws her all the time.
 * @param {import("./sprite").SpriteAtlas} atlas
 * @returns {boolean}
 */
const onlyClose = (atlas) => !!(atlas && atlas.info.close && atlas.info.close.only);

/**
 * Whether the "Miku parts" setting leaves the close-up out ("noIdle", from before 0.1.21, means the same).
 * @param {string} parts
 * @returns {boolean}
 */
const noClose = (parts) =>
  parts === "noClose" || parts === "noIdle" || parts === "bare";

/**
 * The standing or the close-up layer's state, if it was made and nothing it sent was refused.
 * @param {HudApp} hud
 * @param {boolean} close
 * @returns {?(WidgetState & MikuState)}
 */
function layerState(hud, close) {
  let found = null;
  hud.widgets.forEach((state) => {
    if (state.w.type === "miku" && isClose(state.w) === close && !state.refused)
      found = state;
  });
  return found;
}

/**
 * The close-up layer's u_zoom as the standing layer last sent it (zoom, turn, brightness, ready).
 * @param {HudApp} hud
 * @returns {number[]}
 */
function zoomNow(hud) {
  const standing = layerState(hud, false);
  return (
    (standing && standing.zoomVals) || [
      0,
      0,
      hud.themeName === "night" ? MIKU_NIGHT_BRIGHTNESS : 1,
      0,
    ]
  );
}

/**
 * Close-up only: her eyes' closure now (0 open .. 1 shut, miku_only.glsl u_eh): one blink, the bake's (close.blink, a
 * recording's first blink) or else a made-up one, from state.blinkAt; a new one every MIKU_BLINK_MS at random, and
 * when her head sets off on a turn (the update starts that one).
 * @param {MikuState} state the standing layer's
 * @param {number} now ms
 * @returns {number}
 */
function eyeClosure(state, now) {
  if (!isNum(state.blinkNext) || now >= state.blinkNext) {
    if (isNum(state.blinkNext)) state.blinkAt = now;
    state.blinkNext = now + MIKU_BLINK_MS[0] + Math.random() * (MIKU_BLINK_MS[1] - MIKU_BLINK_MS[0]);
  }
  const s = (now - (isNum(state.blinkAt) ? state.blinkAt : -1e9)) / 1000,
    blink = state.blink;
  if (blink) {
    const at = s * blink.rate,
      i = Math.floor(at);
    if (i < 0 || i >= blink.closure.length) return 0;
    const a = blink.closure[i],
      b = i + 1 < blink.closure.length ? blink.closure[i + 1] : 0;
    return Math.round((a + (b - a) * (at - i)) * 100) / 100;
  }
  /** @type {(a: number, b: number, x: number) => number} */
  const smooth = (a, b, x) => {
    const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  return s < 0 || s > 0.3 ? 0 : Math.round(smooth(0, 0.06, s) * (1 - smooth(0.1, 0.22, s)) * 100) / 100;
}

/**
 * One blink out of the bake's blink curve (atlas.json close.blink: a recording's eye closure, `rate` samples a
 * second): from where her eyes first start to shut until they're open again; null if the curve has none.
 * @param {*} close
 * @returns {?{ rate: number, closure: number[] }}
 */
function blinkOf(close) {
  const blink = close && close.blink;
  if (!blink || !(blink.rate > 0) || !Array.isArray(blink.closure) || blink.closure.length < 2) return null;
  const c = blink.closure;
  if (!c.every((v) => typeof v === "number" && v >= 0 && v <= 1)) return null;
  let i0 = -1;
  for (let i = 1; i < c.length && i0 < 0; i++) if (c[i] > 0 && c[i - 1] === 0) i0 = i - 1;
  if (i0 < 0) return null;
  // its end: open again (under MIKU_BLINK_OPEN past its peak; the curve stays a few % shut until the next blink)
  let peak = i0 + 1;
  while (peak + 1 < c.length && c[peak + 1] >= c[peak]) peak++;
  let i1 = peak;
  while (i1 < c.length && c[i1] >= MIKU_BLINK_OPEN) i1++;
  return { rate: blink.rate, closure: c.slice(i0, i1).concat([0]) };
}

/**
 * The pick the standing layer last sent (close-up only: the close-up layer's u_pk).
 * @param {HudApp} hud
 * @returns {number[]}
 */
function pickNow(hud) {
  const standing = layerState(hud, false);
  return (standing && standing.pkSent) || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

/**
 * Close-up only: the two frames miku_only.glsl blends and how far, and their head slides, as u_pk[2]: [the lean's or
 * the turn's chain position of the first frame, the blend to the next, the idle loop's frame, the blend to its next;
 * the slides (px) of those four frames, each frame's head shift less the blended one, so the heads meet; the idle's
 * two frames as the shader reads them, one from each idle atlas (u_idle, u_idle2): their slots there and the second's
 * weight (split, the even frame first: the even frames are in u_idle, the odd in u_idle2)]. The branch
 * follows the shader's: driving (no expressions) the lean, all expressions on and turned the turn. Worked out here,
 * not in the shader: its lookups over the shift tables restarted the KOMBI.
 * @param {MikuState} state the standing layer's
 * @param {number} zoom the close-up's u_zoom.x as sent
 * @param {number} turn its u_zoom.y as sent
 * @param {number} lean -1 .. 1
 * @returns {number[]}
 */
function pickOf(state, zoom, turn, lean) {
  const T = state.turnSteps || 0,
    L = state.leanSteps || 0,
    ts = state.turnShift || [],
    /** @type {(i: number) => number} */
    sh = (i) => ts[i] || 0,
    /** @type {(v: number) => number} */
    clamp1 = (v) => Math.max(-1, Math.min(1, v));
  let p = 0,
    f = 0,
    h0 = 0,
    h1 = 0;
  if (zoom < 0.001 && L) {
    const k = (clamp1(lean) + 1) * L;
    p = Math.min(Math.floor(k), 2 * L - 1);
    f = k - p;
    h0 = sh(2 * T + p);
    h1 = sh(2 * T + p + 1);
  } else if (zoom >= 0.999 && Math.abs(turn) >= 0.001 && T) {
    const k = (clamp1(turn) + 1) * T;
    /** @type {(j: number) => number} */
    const hs = (j) => (j === T ? 0 : sh(j < T ? j : j - 1));
    p = Math.min(Math.floor(k), 2 * T - 1);
    f = k - p;
    h0 = hs(p);
    h1 = hs(p + 1);
  }
  const hc = h0 + (h1 - h0) * f;
  let i0 = 0,
    fi = 0,
    g0 = 0,
    g1 = 0;
  const n = state.idleCount || 0,
    period = state.idlePeriod || 0;
  if (n && period) {
    const k = ((((state.idleT || 0) % period) + period) % period) / period * n,
      ish = state.idleShift || [];
    i0 = Math.min(Math.floor(k), n - 1);
    const x = Math.max(0, Math.min(1, (k - i0 - (1 - IDLE_BLEND)) / IDLE_BLEND));
    fi = x * x * (3 - 2 * x); // smoothstep
    const i1 = i0 + 1 > n - 0.5 ? 0 : i0 + 1,
      a = ish[i0] || 0,
      b = ish[i1] || 0,
      c = a + (b - a) * fi;
    g0 = a - c;
    g1 = b - c;
  }
  // the idle's two frames, one from each atlas: split, the even one from u_idle (slot n >> 1), the odd from u_idle2
  const i1 = n ? (i0 + 1 > n - 0.5 ? 0 : i0 + 1) : 0;
  let a = [i0, g0],
    b = [i1, g1],
    wb = fi;
  if (state.idleSplit && i0 % 2) {
    a = [i1, g1];
    b = [i0, g0];
    wb = 1 - fi;
  }
  const slot = (/** @type {number} */ k) => (state.idleSplit ? k >> 1 : k);
  /** @type {(v: number) => number} */
  const r = (v) => Math.round(v * 1000) / 1000;
  return [p, r(f), i0, r(fi), r(h0 - hc), r(h1 - hc), r(a[1]), r(b[1]), slot(a[0]), slot(b[0]), r(wb), 0];
}
/**
 * Where the standing frame's top-left sits in a widget's layer (px): the bake's "anchor" (between her feet) on the
 * widget's "feet" point.
 * @param {Widget} widget
 * @param {import("./sprite").MikuInfo} info
 * @returns {number[]}
 */
function originOf(widget, info) {
  const feet =
    Array.isArray(widget.feet) && widget.feet.length === 2
      ? widget.feet
      : MIKU_FEET;
  return [
    feet[0] - widget.x - info.anchor[0],
    feet[1] - widget.y - info.anchor[1],
  ];
}

module.exports = {
  type: "miku",
  fields: [],
  docs: DOCS,
  time: true,
  /** The shader to draw her with, or null (the reason logged) when her frames are missing or bad, or (the close-up)
   * when there is no close-up or the "Miku parts" setting leaves it out.
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {number} connIndex connection index
   * @returns {?string}
   */
  shader(hud, widget, connIndex) {
    const atlas = sprite(hud, widget, connIndex);
    if (!atlas) return null;
    const parts = hud.setting("mikuParts");
    if (onlyClose(atlas)) {
      // close-up only: the "Miku parts" setting has nothing to leave out; the standing layer only runs her
      if (!isClose(widget)) return MIKU_NONE;
      return closeSprite(hud, atlas, connIndex) ? MIKU_ONLY : null;
    }
    if (isClose(widget)) {
      if (noClose(parts) || !closeSprite(hud, atlas, connIndex)) return null;
      return MIKU_CLOSE;
    }
    return (parts === "bare" ? "#define MIKU_BARE\n" : "") + MIKU;
  },
  /** For tools/shader_budget.js: every shader the layers and the "Miku parts" setting can pick.
   * @type {Record<string, string>} */
  shaders: {
    miku: MIKU,
    "miku (bare)": "#define MIKU_BARE\n" + MIKU,
    "miku close-up": MIKU_CLOSE,
    "miku close-up only": MIKU_ONLY,
  },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & MikuState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref;
    const atlas = sprite(hud, widget, state.ci),
      info = atlas.info,
      origin = originOf(widget, info),
      close = info.close;
    const only = onlyClose(atlas);
    if (only && !isClose(widget)) {
      state.only = true; // close-up only: the standing layer runs her (update) and draws nothing
      state.leanSteps = atlas.info.close.leanSteps || 0;
      state.idlePeriod = atlas.info.close.idle ? atlas.info.close.idle.period : 0;
      state.turnSteps = atlas.info.close.turnSteps || 0;
      state.turnShift = atlas.info.close.turnShift || [];
      state.idleShift = atlas.info.close.idle ? atlas.info.close.idle.shift || [] : [];
      state.idleCount = atlas.info.close.idle ? atlas.info.close.idle.count || 0 : 0;
      state.idleSplit = !!(atlas.info.close.idle && atlas.info.close.idle.split);
      state.blink = blinkOf(atlas.info.close);
      return;
    }
    if (!isClose(widget)) state.only = false;
    if (isClose(widget)) {
      // the close-up: its own atlas and the bake's fixed values (shader.js MIKU_CLOSE u_cl); the standing layer
      // sends u_zoom as it moves
      const closeAtlas = closeSprite(hud, atlas, state.ci);
      client.bind(ref, "u_atlas", closeAtlas.ref);
      if (!only) client.uniform(ref, "u_size", [widget.w, widget.h]);
      client.uniform(ref, "u_atlasSize", closeAtlas.size);
      if (!only)
        client.uniform(ref, "u_cam", [
          -origin[0],
          -origin[1],
          widget.w,
          widget.h,
        ]);
      const rects = [0, 1, 2, 3].map(
        (i) => close.rects[Math.min(i, close.rects.length - 1)],
      );
      const shift = [0, 1, 2, 3].map((i) => close.turnShift[i] || 0);
      client.uniform(
        ref,
        "u_cl",
        [].concat(
          ...rects,
          close.grid,
          close.cropGrid,
          close.crop,
          [
            close.pivot[0],
            close.pivot[1],
            close.swayAngle[0],
            close.swayAngle[1],
          ],
          // close-up only: u_cl[8] holds the lean's steps each way (miku_only.glsl u_drv); else the first turn shifts
          only ? [close.leanSteps || 0, 0, 0, 0] : shift,
          [close.frame[0], close.frame[1], close.zoomSteps, close.turnSteps],
        ),
        { type: "vec4" },
      );
      // the turn frames' head shifts, left to right, four a vec4 (miku_close.glsl u_tsh[9]: up to 18 steps each way);
      // close-up only, the app picks the frames and their slides (u_pk)
      if (!only) {
        const tsh = [];
        for (let i = 0; i < CLOSE_TURN_SHIFT_SLOTS; i++) tsh.push(close.turnShift[i] || 0);
        client.uniform(ref, "u_tsh", tsh, { type: "vec4" });
      }
      client.uniform(ref, "u_zoom", zoomNow(hud));
      if (only) {
        client.uniform(ref, "u_pk", pickNow(hud), { type: "vec4" });
        client.uniform(ref, "u_eh", [0]);
        // the lean's own atlas (miku_only.glsl u_leanAtlas): its size and where its crops start
        if (closeAtlas.leanRef) {
          client.bind(ref, "u_leanAtlas", closeAtlas.leanRef);
          client.uniform(ref, "u_lc", [closeAtlas.leanSize[0], closeAtlas.leanSize[1], close.leanAtlas.cropY, 0]);
        }
        // the stopped idle loop's own atlas (miku_only.glsl u_idle), when the bake has one
        const idle = close.idle;
        if (idle && closeAtlas.idleRef) {
          client.bind(ref, "u_idle", closeAtlas.idleRef);
          // its odd frames (close.idle.split); else the same asset, so the shader's second idle read has a texture
          client.bind(ref, "u_idle2", closeAtlas.idle2Ref || closeAtlas.idleRef);
          client.uniform(ref, "u_idleSize", closeAtlas.idleSize || [1, 1]);
          client.uniform(ref, "u_ic", [].concat(idle.grid, idle.cropGrid, idle.crop, [idle.count, idle.period, 0, 0]), {
            type: "vec4",
          });
        } else client.uniform(ref, "u_ic", [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0], { type: "vec4" });
      }
      return;
    }
    /** @type {(k: string) => number[]} */
    const frameRect = (k) =>
      (info.frames && info.frames[k]) || info.frames.idle;
    /** @type {(part: *) => number[]} */
    const rect = (part) =>
      part && Array.isArray(part.rect) ? part.rect : [0, 0, 0, 0];
    client.bind(ref, "u_atlas", atlas.ref);
    if (atlas.tableRef) client.bind(ref, "u_table", atlas.tableRef);
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_atlasSize", atlas.size);
    client.uniform(ref, "u_frame", info.frame);
    client.uniform(ref, "u_origin", origin);
    // the fixed sprite values go up as three vec4 arrays (u_spr: the eye frames, the tails, the crop and the
    // tables' counts; u_arm), which shader.js names back with #define; the per-frame tables (lean frames, head
    // shifts) are pixel rows under the atlas (_sprite, mikuData). Few uniforms: the cluster's GPU restarted on the
    // 0.1.9 .. 0.1.12 shader's 55 uniform vectors (or its size)
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
    /** @type {number[]} */
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
      ((isNum(widget.point) ? widget.point : MIKU_POINT_DEG) * Math.PI) / 180,
      // the arms balance a sideways lean only: leaning toward or away from you they just ride along
      info.leanAxis === "fb"
        ? 0
        : ((isNum(widget.balance) ? widget.balance : MIKU_BALANCE_DEG) * Math.PI) / 180,
    ]);
    // the zoom's end, the close-up's view (none: she never zooms), and where she has faded out by: the close-up's
    // first zoom step
    state.firstStep = close ? 1 / (close.zoomSteps + 1) : 0;
    client.uniform(
      ref,
      "u_close",
      close ? close.rects[close.rects.length - 1] : [0, 0, 0, 0],
    );
    client.uniform(ref, "u_first", close ? close.rects[0] : [0, 0, 0, 0]);
    client.uniform(ref, "u_zoom", [0, state.firstStep, 0, 0]);
    client.uniform(ref, "u_hip", [
      info.hipY,
      isNum(info.headY) ? info.headY : 0,
      info.breathe === false ? 0 : 1,
      0,
    ]);
    // her lean and zoom on their own timer at the renderer's frame rate, not the 20 Hz tick, where a lean would move
    // only every other frame and step; faster than the renderer draws would send frames it never shows. A message
    // goes up only when one changes a step
    state.timer = setInterval(
      () =>
        hud._guard("widget " + widget.id, () => {
          if (hud._offScreen()) return;
          if (hud._freshData) hud._freshData();
          hud._update(state, Date.now(), false);
        }),
      MIKU_MS,
    );
    const tails = info.tails || null;
    // u_spr[4]: the rect the face frames are crops of (none: an older bake's whole frames)
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
        [atlas.counts.lean, 0, 0, atlas.dataY],
      ),
      { type: "vec4" },
    );
  },
  /**
   * The "Reset Miku" setting: back to standing upright, as if nothing had happened: the close-up snaps out (its
   * expressions off), the lean, the arm and the speed's sway at rest, the still-standing timer at 0. Both layers get
   * it at once.
   * @param {HudApp} hud
   * @param {WidgetState & MikuState} state
   */
  reset(hud, state) {
    if (isClose(state.w)) return;
    state.lean = 0;
    state.leanStep = 0;
    state.leanEased = 0;
    state.spd = 0;
    state.point = 0;
    state.pointV = 0;
    state.zoom = 0;
    state.zoomT = 0;
    state.stillMs = 0;
    state.at = Date.now();
    hud._update(state, state.at, true);
  },
  /**
   * The standing layer runs her: the lean, the arm, the zoom, and the close-up layer's uniforms with them. The
   * close-up layer only takes its last values when it is (re)made.
   * @param {HudApp} hud
   * @param {WidgetState & MikuState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    if (isClose(state.w)) {
      if (force) state.c.uniform(state.ref, "u_zoom", zoomNow(hud));
      return;
    }
    // lean: the longitudinal g, -0.4 g .. +0.4 g to -1 .. 1, eased over MIKU_LEAN_TAU_MS; speed 0..130 km/h to
    // 0..1, eased over MIKU_TAU_MS; both sent in steps of 0.002 (a small uniform message, at most one per MIKU_MS, and only while she moves)
    const data = hud.car.data(),
      dt = state.at ? Math.min(MIKU_MAX_DT_MS, now - state.at) : 0;
    state.at = now;
    // standing on a bus: the lean eases toward the g (as Unreal's FInterpTo, but 1 - exp(-dt / tau), the same at
    // any update rate), so she leans into a pull and straightens when it ends, without swaying back past upright;
    // the ease also smooths the car's steppy, noisy g
    // close-up only: no lean while the expressions are (coming) on, so she drives off upright and leans from there
    const only = !!state.only,
      exprOn = only && ((state.zoom || 0) > 0 || (state.zoomT || 0) > 0);
    const leanTarget = isNum(data.gLong) && !exprOn
      ? Math.max(-MIKU_LEAN_G, Math.min(MIKU_LEAN_G, data.gLong)) / MIKU_LEAN_G
      : 0;
    state.lean = isNum(state.lean)
      ? state.lean +
        (leanTarget - state.lean) * (1 - Math.exp(-dt / MIKU_LEAN_TAU_MS))
      : leanTarget;
    // pointing: toward the indicator ('L' -1, 'R' 1, hazards or none 0), on a quicker spring (about 1.3 Hz, no
    // overshoot) so the arm rises and falls smoothly; in the close-up it turns her head
    // close-up only: the head turns once the expressions are all on (the turn frames have them)
    const turnSide = only && (state.zoom || 0) < 1 ? 0 : hud._turnSide(),
      dtp = dt / 1000;
    // close-up only: she blinks as her head starts to turn, away or back, as in the turn recording (each of its four
    // blinks comes as the head sets off); the next one MIKU_BLINK_MS after
    if (only && isNum(state.turnWas) && turnSide !== state.turnWas) {
      state.blinkAt = now;
      state.blinkNext = now + MIKU_BLINK_MS[0] + Math.random() * (MIKU_BLINK_MS[1] - MIKU_BLINK_MS[0]);
    }
    state.turnWas = turnSide;
    if (!isNum(state.point)) {
      state.point = turnSide;
      state.pointV = 0;
    }
    for (let left = dtp; left > 0; left -= MIKU_POINT_STEP_S) {
      const stepSec = Math.min(MIKU_POINT_STEP_S, left);
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
      speedFrac = isNum(speed) ? Math.min(1, Math.max(0, speed / MIKU_SPEED_KMH)) : 0,
      /** @type {(value: number) => number} */
      step = (value) => Math.round(value * MIKU_STEPS) / MIKU_STEPS;
    state.spd = isNum(state.spd)
      ? state.spd + (speedFrac - state.spd) * (1 - Math.exp(-dt / MIKU_TAU_MS))
      : speedFrac;
    // the close-up: stood still (speed 0) for MIKU_STILL_MS, she zooms in over MIKU_ZOOM_MS; past MIKU_ZOOM_OUT_KMH
    // back out (in between she stays as she is). Only with a close-up layer: without one she would fade to nothing
    const close = layerState(hud, true),
      still = isNum(speed) && speed < MIKU_STILL_KMH;
    state.stillMs = still ? (state.stillMs || 0) + dt : 0;
    // close-up only: an indicator brings the expressions on too (she turns toward it with them), at any speed
    // and they stay on until her head is back from a turn (the in-steps are upright: going off still turned jumped)
    if (close && only && (hud._turnSide() || Math.abs(state.point || 0) > MIKU_TURN_BACK)) state.zoomT = 1;
    else if (!close || !isNum(speed) || speed > MIKU_ZOOM_OUT_KMH) state.zoomT = 0;
    else if (state.stillMs >= MIKU_STILL_MS) state.zoomT = 1;
    const zoomT = state.zoomT || 0,
      zoom = isNum(state.zoom) ? state.zoom : 0,
      move = dt / (only ? MIKU_IN_MS : MIKU_ZOOM_MS);
    state.zoom =
      zoomT > zoom
        ? Math.min(zoomT, zoom + move)
        : Math.max(zoomT, zoom - move);
    const brightness = hud.themeName === "night" ? MIKU_NIGHT_BRIGHTNESS : 1;
    // a soft curve: the lean eases in toward a full one, divided by its value there so MIKU_LEAN_G is the full lean
    // (without it the curve stopped at tanh(1.15) = 82%: the last two of 10 baked steps each way never showed)
    // close-up only: the smoothed lean picks a baked step, with hysteresis (it moves on only MIKU_LEAN_HYST of a step
    // past one, so a g jittering round a step's edge, where the faces start (eyes open, then shut), doesn't flick
    // between the two), and she eases to that step: a steady pull rests on one frame, not a half-and-half blend of two
    let leanShown = Math.tanh(state.lean * MIKU_LEAN_SOFT) / Math.tanh(MIKU_LEAN_SOFT);
    if (only && state.leanSteps) {
      const n = state.leanSteps,
        at = leanShown * n,
        held = isNum(state.leanStep) ? state.leanStep : Math.round(at);
      state.leanStep = Math.abs(at - held) > MIKU_LEAN_HYST ? Math.round(at) : held;
      const to = state.leanStep / n;
      state.leanEased = isNum(state.leanEased)
        ? state.leanEased + (to - state.leanEased) * (1 - Math.exp(-dt / MIKU_LEAN_STEP_TAU_MS))
        : to;
      if (Math.abs(state.leanEased - to) < MIKU_LEAN_SNAP) state.leanEased = to;
      leanShown = state.leanEased;
    }
    const drive = [
      step(leanShown),
      step(state.spd),
      0, // standing she doesn't point toward the indicator; only the close-up turns her head (state.point)
      brightness,
    ];
    // the zoom to both layers, the head's turn to the close-up's; its w says the close-up's atlas is there (a close-up
    // layer whose atlas or bind was refused gets 0 once and draws nothing, rather than sampling whatever texture is bound)
    hud.widgets.forEach((other) => {
      if (
        other.w.type === "miku" &&
        isClose(other.w) &&
        other.refused &&
        !other.blanked
      ) {
        other.blanked = true;
        other.c.uniform(other.ref, "u_zoom", [0, 0, brightness, 0]);
      }
    });
    // close-up only: the expressions come on and go off eased in and out (smoothstep), so Yandere's hands start
    // rising gently and settle at her cheeks instead of moving at one speed and stopping dead
    const zoomShown = only ? state.zoom * state.zoom * (3 - 2 * state.zoom) : state.zoom;
    const zoomVals = [
        step(zoomShown),
        step(state.point),
        brightness,
        close ? 1 : 0,
      ],
      keyZ = zoomVals.join("|");
    if (force || zoomVals[0] !== (state.zoomVals || [])[0])
      state.c.uniform(state.ref, "u_zoom", [
        zoomVals[0],
        state.firstStep || 0,
        0,
        0,
      ]);
    if (force || keyZ !== state.lastZ) {
      state.lastZ = keyZ;
      state.zoomVals = zoomVals;
      if (close) close.c.uniform(close.ref, "u_zoom", zoomVals);
    }
    // the close-up's blink and sway clock, seconds 0 .. 4, about 30 times a second while she is (partly) zoomed in;
    // the renderer's u_time didn't drive that layer on the car (a large u_time keeps no fractions in a mediump float)
    if (
      close &&
      (only || state.zoom > 0) &&
      (force || now - (state.clockAt || 0) >= MIKU_CLOCK_MS)
    ) {
      state.clockAt = now;
      // close-up only: her eyes' closure (the bake's blink curve) instead of the clock, sent when it changes
      if (only) {
        const eh = eyeClosure(state, now);
        if (force || eh !== state.ehSent) {
          state.ehSent = eh;
          close.c.uniform(close.ref, "u_eh", [eh]);
        }
      } else
        close.c.uniform(close.ref, "u_clock", [
          (((now % MIKU_CLOCK_LOOP_MS) + MIKU_CLOCK_LOOP_MS) % MIKU_CLOCK_LOOP_MS) / 1000,
        ]);
      // close-up only with an idle loop: where she is in it. From its first frame (upright, where the in-steps end) as
      // the expressions finish coming on; held while her head turns away (the turn blends from that frame), and back
      // to its first frame once she's past the turn's first step (no longer seen), so turning back lands on upright,
      // as the turn's first step is (it jumped to wherever the loop had run on to)
      if (only && state.idlePeriod) {
        const turned = Math.abs(state.point || 0),
          firstStep = 1 / Math.max(1, state.turnSteps || 1);
        // and upright and still for MIKU_SETTLE_MS once her layer is shown (first, or back after giving way): her
        // textures' upload is paid off then (cluster-render paces what goes to the KOMBI and holds the HUD's frames
        // meanwhile, so the loop jerked along for a few seconds)
        const layer = hud.layerStates.get(close.ci + ":" + close.ref);
        if (!layer || layer.state !== "shown") state.shownAt = 0;
        else if (!state.shownAt) state.shownAt = now;
        if (!state.shownAt || now - state.shownAt < MIKU_SETTLE_MS) state.idleMs = 0;
        else if (state.zoomT === 1 && state.zoom < 1) state.idleMs = 0;
        else if (turned > firstStep) state.idleMs = 0;
        else if (turned <= MIKU_TURN_BACK) state.idleMs = (state.idleMs || 0) + (now - (state.idleAt || now));
        state.idleAt = now;
        const loopMs = state.idlePeriod * 1000;
        state.idleT = ((state.idleMs || 0) % loopMs) / 1000;
      }
    }
    // close-up only: the frames the close-up layer blends and their slides, from the lean, the turn and the idle
    if (only && close) {
      const pk = pickOf(state, zoomVals[0], zoomVals[1], drive[0]);
      if (force || !state.pkSent || pk.join("|") !== state.pkSent.join("|")) {
        state.pkSent = pk;
        close.c.uniform(close.ref, "u_pk", pk, { type: "vec4" });
      }
    }
    const key = drive.join("|");
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_drive", drive);
  },
};
