"use strict";
/**
 * The "revbar" widget: an effect layer.
 */
const { isNum, rgb, rgba } = require("../../engine/util");
const REVBAR = require("./shader");

const REVBAR_TOP_PX = 8; // default room for the marks above the bar
const REVBAR_SLANT_PX = 12; // default slant
const REVBAR_RPM_STEP = 10; // rpm and peak are resent only in 10 rpm steps

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; revbar/shader.js, the G20-style slanted rev bar (Redline layout): "barH" bar height, "top" room for the marks above it, "slant" px, "over" rpm past the redline's thousand the scale runs to (1000: a 7000 redline gives 0..8)`;

module.exports = {
  type: "revbar",
  fields: ["barH"],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return REVBAR;
  },
  shaders: { revbar: REVBAR },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_top", [widget.top || REVBAR_TOP_PX]);
    client.uniform(ref, "u_barH", [widget.barH]);
    client.uniform(ref, "u_slant", [widget.slant || REVBAR_SLANT_PX]);
    client.uniform(ref, "u_max", [hud._barMax(widget)]);
    client.uniform(ref, "u_red", [hud.setting("redline")]);
    client.uniform(ref, "u_from", rgb(theme.rev.from));
    client.uniform(ref, "u_to", rgb(theme.rev.to));
    client.uniform(ref, "u_hot", rgb(theme.hot));
    client.uniform(ref, "u_track", rgba(theme.track));
    client.uniform(ref, "u_tick", rgba(theme.dim));
    client.uniform(ref, "u_fg", rgba(theme.fg));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const rpm = hud._raw("rpm"),
      shift = hud._shift();
    const value = isNum(rpm) ? Math.round(Math.max(0, rpm) / REVBAR_RPM_STEP) * REVBAR_RPM_STEP : 0;
    const peak = Math.round(hud.score.peak / REVBAR_RPM_STEP) * REVBAR_RPM_STEP;
    const key = value + "|" + shift.rpm + "|" + peak + "|" + shift.now;
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_value", [value]);
    state.c.uniform(state.ref, "u_shift", [shift.rpm]);
    state.c.uniform(state.ref, "u_peak", [peak]);
    state.c.uniform(state.ref, "u_shiftNow", [shift.now ? 1 : 0]);
  },
};
