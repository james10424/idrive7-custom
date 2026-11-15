"use strict";
/**
 * The "f16" widget: an F-16 style HUD on one effect layer (f16.glsl), the car's values in the jet's symbols.
 */
const { isNum, rgba } = require("../../engine/util");
const textRaster = require("../../hud_text");
const F16 = require("./shader");
const { MI_PER_KM } = require("../../car/consts");

const F16_GREEN = [40, 255, 110, 255]; // HUD green
const F16_NIGHT = 0.75; // the night theme draws it this bright
const F16_FONT = "mid"; // the glyph atlas the numbers come from
const F16_SPEED_TOP_KMH = 260; // the airspeed tape's scale, km/h
const F16_SPEED_TOP_MPH = 160; // with US units, mph
const F16_SPEED_PX = { kmh: 2, mph: 3 }; // tape px a unit
const F16_SPEED_STEP = { kmh: 20, mph: 10 }; // labels every this many
const F16_RPM_TOP = 700; // the altitude tape: rpm / 10, 0 .. 7000 rpm
const F16_RPM_PX = 0.6; // tape px a unit (rpm / 10)
const F16_RPM_STEP = 100; // labels every 1000 rpm
const F16_TAPE_EDGE = 15; // the tapes end this far from the layer's top and bottom, px
const F16_PITCH_PX = 8; // ladder px a degree of pitch
const F16_HDG_PX = 4; // heading tape px a degree
const F16_BANK_R = 110; // the bank scale's radius, px: an arc at the bottom, its centre above it
const F16_BANK_BOTTOM = 266; // its lowest tick's end, layer px from the top (the pointer under it)
const F16_LADDER_CLEAR = 60; // the ladder stops this far above the bank scale's bottom
// the g's part of the attitude, on top of the road's own slope (car/signals.js _onSlope)
const F16_PITCH_DEG_G = 12; // pitch (nose up) a g of longitudinal acceleration
const F16_FPV_X_G = 110; // the flight path vector's px a g sideways (toward the turn), the ladder with it
const F16_FPV_MAX = 70; // it stays this near the middle, px
const F16_G_TAU_MS = 200; // the g eased this smoothly
const F16_MAX_DT_MS = 500;
const F16_SEND_MS = 33; // the attitude goes up at most this often
const F16_FRESH_MS = 3000; // the car's slope and heading count this long after they last came
const F16_SLOPE_TAU_MS = 400; // the road's slope eased this smoothly (it comes in 0.1 % steps)

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} F16State
 * @property {number} [gLong] eased
 * @property {number} [gLat] eased
 * @property {number} [at] the last update (ms)
 * @property {number} [sentAt] when the attitude last went up (ms)
 * @property {string} [lastAtt] the attitude last sent
 * @property {string} [lastVals] the tapes' values last sent
 * @property {number} [roadPitch] the road's gradient front to back, deg, eased
 * @property {number} [roadRoll] and side to side, deg, eased
 * @property {string} [lastHdg] the heading last sent
 */

const DOCS = `effect layer (f16/f16.glsl): an F-16 style HUD in HUD green, one layer the visible window's size. The airspeed tape on the left is the speed (0..260 km/h, 0..160 mph with US units), its box the speed in digits; the altitude tape on the right is the rpm / 10 (0..700), its box likewise; the pitch ladder (rungs every 5 deg, dashed below the horizon) and the horizon line between them show pitch and roll, the flight path vector shows where the car travels (along the road as the nose pitches, sliding toward the turn with the ladder), the bank angle scale points at the road's camber, and the heading tape shows at the top once the car gives a heading. The pitch and bank are the road's own gradient and camber (LaneSlope) plus the g's (12 deg a g of longitudinal g as the body squats or dives); the lateral g slides the flight path vector sideways toward the turn, the ladder and horizon centred on it; the heading comes from navigation's position. Its numbers come from the "font" glyph atlas (mid). The tapes run the window's full height (BMW's speed sign draws over the airspeed tape's lower part), the bank scale sits at the bottom. Fields: "tapeX" [airspeed line x, altitude line x] (layer px, default 112 and 448), "mid" [ladder centre x, tapes' middle y] (default the layer's middle).`;

/**
 * The layer's geometry: the tapes' lines, the ladder's centre, the tapes' middle.
 * @param {Widget} widget
 * @returns {{ sx: number, rx: number, cx: number, my: number }}
 */
function geometry(widget) {
  const tape = Array.isArray(widget.tapeX) ? widget.tapeX : [112, widget.w - 112];
  const mid = Array.isArray(widget.mid) ? widget.mid : [widget.w / 2, widget.h / 2];
  return { sx: tape[0], rx: tape[1], cx: mid[0], my: mid[1] };
}

module.exports = {
  type: "f16",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return F16;
  },
  shaders: { f16: F16 },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & F16State} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref;
    const fontName = widget.font || F16_FONT;
    const atlas = hud._atlas(fontName, state.ci);
    const glyphs = textRaster.loadFont(fontName).metrics.glyphs;
    const advance = glyphs["0"] ? glyphs["0"].advance : atlas.cellW * 0.5;
    const dig = "0123456789"
      .split("")
      .map((char) => Math.max(0, atlas.chars.indexOf(char)))
      .concat([0, 0]);
    const g = geometry(widget);
    const night = hud.themeName === "night" ? F16_NIGHT : 1;
    client.bind(ref, "u_font", atlas.ref);
    client.uniform(ref, "u_grid", [atlas.cols, atlas.rows]);
    client.uniform(ref, "u_cell", [atlas.cellW, atlas.cellH, advance, 1]);
    client.uniform(ref, "u_dig", dig, { type: "vec4" });
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_color", rgba([F16_GREEN[0] * night, F16_GREEN[1] * night, F16_GREEN[2] * night, 255]));
    const half = Math.min(g.my, widget.h - g.my) - F16_TAPE_EDGE,
      bankBottom = Math.min(widget.h - 4, F16_BANK_BOTTOM);
    client.uniform(ref, "u_geo", [g.cx, g.my, F16_PITCH_PX, half]);
    client.uniform(ref, "u_box", [g.sx, g.rx, g.my, 0]);
    // the bank scale's centre above its arc, so the 0 deg tick ends at bankBottom (its pointer just inside)
    client.uniform(ref, "u_bank", [g.cx, bankBottom - 12 - F16_BANK_R, F16_BANK_R, bankBottom - F16_LADDER_CLEAR]);
    client.uniform(ref, "u_hdg", [0, 0, F16_HDG_PX, 0]);
    state.lastAtt = "";
    state.lastVals = "";
    module.exports.update(hud, state, Date.now(), true);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & F16State} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const data = hud.car.data(),
      dt = state.at ? Math.min(F16_MAX_DT_MS, now - state.at) : 0;
    state.at = now;
    const k = 1 - Math.exp(-dt / F16_G_TAU_MS);
    /** @type {(was: number | undefined, v: *) => number} */
    const ease = (was, v) => {
      const to = isNum(v) ? v : 0;
      return isNum(was) ? was + (to - was) * k : to;
    };
    state.gLong = ease(state.gLong, data.gLong);
    state.gLat = ease(state.gLat, data.gLat);
    // the tapes: the speed in the units setting's unit, the rpm / 10
    const us = hud.setting("units") === "us",
      unit = us ? "mph" : "kmh",
      kmh = hud._raw("speed"),
      speed = isNum(kmh) ? Math.max(0, us ? kmh * MI_PER_KM : kmh) : 0,
      rpm = hud._raw("rpm"),
      rpm10 = isNum(rpm) ? Math.max(0, rpm / 10) : 0;
    const spd = [Math.round(speed * 10) / 10, F16_SPEED_PX[unit], F16_SPEED_STEP[unit], us ? F16_SPEED_TOP_MPH : F16_SPEED_TOP_KMH];
    const rpmv = [Math.round(rpm10 * 10) / 10, F16_RPM_PX, F16_RPM_STEP, F16_RPM_TOP];
    const vals = spd.join(",") + "|" + rpmv.join(",");
    if (force || vals !== state.lastVals) {
      state.lastVals = vals;
      state.c.uniform(state.ref, "u_spd", spd);
      state.c.uniform(state.ref, "u_rpm", rpmv);
    }
    // the heading tape, while navigation's position gives one
    const hdgOn = isNum(hud.heading) && now - (hud.headingAt || 0) < F16_FRESH_MS,
      hdg = [hdgOn ? Math.round(hud.heading * 10) / 10 : 0, hdgOn ? 1 : 0, F16_HDG_PX, 0],
      hdgKey = hdg.join(",");
    if (force || hdgKey !== state.lastHdg) {
      state.lastHdg = hdgKey;
      state.c.uniform(state.ref, "u_hdg", hdg);
    }
    // the attitude: the road's own slope (LaneSlope, car/signals.js; 0 without it), plus the longitudinal g's pitch as
    // the body squats pulling away and dives braking; the bank is the road's camber alone. The lateral g slides the
    // flight path vector sideways toward the turn (a left turn's lateral g is +: left), the ladder and the horizon
    // with it (the F-16's ladder is centred on the vector)
    const slopeOn = now - (hud.slopeAt || 0) < F16_FRESH_MS,
      ks = 1 - Math.exp(-dt / F16_SLOPE_TAU_MS);
    /** @type {(was: number | undefined, v: *) => number} */
    const easeSlope = (was, v) => {
      const to = slopeOn && isNum(v) ? v : 0;
      return isNum(was) ? was + (to - was) * ks : to;
    };
    state.roadPitch = easeSlope(state.roadPitch, hud.slopePitch);
    state.roadRoll = easeSlope(state.roadRoll, hud.slopeRoll);
    if (!force && now - (state.sentAt || 0) < F16_SEND_MS) return;
    const clampFpv = (/** @type {number} */ v) => Math.max(-F16_FPV_MAX, Math.min(F16_FPV_MAX, v));
    const gPitch = state.gLong * F16_PITCH_DEG_G,
      pitch = state.roadPitch + gPitch,
      roll = (state.roadRoll * Math.PI) / 180,
      lat = Math.max(-F16_FPV_MAX, Math.min(F16_FPV_MAX, -state.gLat * F16_FPV_X_G)),
      // the flight path vector shows where the car travels, not where its nose points: along the road, so climbing
      // it sits above the horizon by the gradient, and as the nose squats or dives it stays where the road goes
      // (it moves against the g's pitch): that offset in the horizon's frame, rolled as the shader rolls the ladder,
      // then the sideways slide the ladder shares
      hy = gPitch * F16_PITCH_PX,
      fx = clampFpv(lat - Math.sin(roll) * hy),
      fy = clampFpv(Math.cos(roll) * hy);
    const att = [Math.round(pitch * 20) / 20, Math.round(roll * 500) / 500, Math.round(fx), Math.round(fy)];
    const key = att.join(",") + "|" + Math.round(lat);
    if (!force && key === state.lastAtt) return;
    state.lastAtt = key;
    state.sentAt = now;
    state.c.uniform(state.ref, "u_att", att);
    state.c.uniform(state.ref, "u_lat", [Math.round(lat)]);
  },
};
