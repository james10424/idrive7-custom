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
const F16_TAPE_HALF = 92; // the tapes' and the ladder's half height, px
const F16_PITCH_PX = 8; // ladder px a degree of pitch
const F16_HDG_PX = 4; // heading tape px a degree
const F16_BANK_R = 96; // the bank scale's radius from the ladder's centre, px
// the g fallback, until the car's own pitch, roll and heading are found (car/attitude_probe.js)
const F16_PITCH_DEG_G = 12; // pitch (nose up) a g of longitudinal acceleration
const F16_ROLL_DEG_G = 30; // bank a g of lateral acceleration (into the turn, as a jet banks)
const F16_FPV_X_G = 110; // the flight path vector's px a g sideways (toward the turn)
const F16_FPV_Y_G = 80; // and up a g of acceleration (down braking)
const F16_FPV_MAX = 70; // it stays this near the middle, px
const F16_G_TAU_MS = 200; // the g eased this smoothly
const F16_MAX_DT_MS = 500;
const F16_SEND_MS = 33; // the attitude goes up at most this often

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
 */

const DOCS = `effect layer (f16/f16.glsl): an F-16 style HUD in HUD green, one layer the visible window's size. The airspeed tape on the left is the speed (0..260 km/h, 0..160 mph with US units), its box the speed in digits; the altitude tape on the right is the rpm / 10 (0..700), its box likewise; the pitch ladder (rungs every 5 deg, dashed below the horizon) and the horizon line between them show pitch and roll, the flight path vector moves with the g, the bank angle scale under it points at the roll, and the heading tape shows at the top once the car gives a heading. Until the car's own pitch, roll and heading are read, the pitch is the longitudinal g (12 deg a g), the roll the lateral g (30 deg a g, into the turn) and there is no heading. Its numbers come from the "font" glyph atlas (mid). Fields: "tapeX" [airspeed line x, altitude line x] (layer px, default 112 and 448), "mid" [ladder centre x, tapes' middle y] (default the layer's middle, 116).`;

/**
 * The layer's geometry: the tapes' lines, the ladder's centre, the tapes' middle.
 * @param {Widget} widget
 * @returns {{ sx: number, rx: number, cx: number, my: number }}
 */
function geometry(widget) {
  const tape = Array.isArray(widget.tapeX) ? widget.tapeX : [112, widget.w - 112];
  const mid = Array.isArray(widget.mid) ? widget.mid : [widget.w / 2, 116];
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
    client.uniform(ref, "u_geo", [g.cx, g.my, F16_PITCH_PX, F16_TAPE_HALF]);
    client.uniform(ref, "u_box", [g.sx, g.rx, g.my, F16_BANK_R]);
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
    // the attitude from the g (a left turn's lateral g is +: the jet banks left, the vector slides left)
    if (!force && now - (state.sentAt || 0) < F16_SEND_MS) return;
    const clampFpv = (/** @type {number} */ v) => Math.max(-F16_FPV_MAX, Math.min(F16_FPV_MAX, v));
    const pitch = state.gLong * F16_PITCH_DEG_G,
      roll = (state.gLat * F16_ROLL_DEG_G * Math.PI) / 180,
      fx = clampFpv(-state.gLat * F16_FPV_X_G),
      fy = clampFpv(-state.gLong * F16_FPV_Y_G);
    const att = [Math.round(pitch * 20) / 20, Math.round(roll * 500) / 500, Math.round(fx), Math.round(fy)];
    const key = att.join(",");
    if (!force && key === state.lastAtt) return;
    state.lastAtt = key;
    state.sentAt = now;
    state.c.uniform(state.ref, "u_att", att);
  },
};
