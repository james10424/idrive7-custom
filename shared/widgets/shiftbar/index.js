"use strict";
/**
 * The "shiftbar" widget: an effect layer.
 */
const { isNum, rgb, rgba } = require("../../engine/util");
const SHIFTBAR = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; shiftbar/shader.js, lit by rpm, zones from the redline`;

module.exports = {
  type: "shiftbar",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return SHIFTBAR;
  },
  shaders: { shiftbar: SHIFTBAR },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    const max = hud._barMax(),
      red = hud.setting("redline");
    const midAt =
      theme.bar.midAt === "shift" ? (red - 1500) / max : theme.bar.midAt;
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_segs", [widget.segments || 40]);
    client.uniform(ref, "u_low", rgb(theme.bar.low));
    client.uniform(ref, "u_mid", rgb(theme.bar.mid));
    client.uniform(ref, "u_high", rgb(theme.bar.high));
    client.uniform(ref, "u_midAt", [midAt]);
    client.uniform(ref, "u_highAt", [(red - 500) / max]);
    client.uniform(ref, "u_track", rgba(theme.track));
    client.uniform(ref, "u_flash", [0]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    const rpm = hud._raw("rpm");
    const segs = widget.segments || 40;
    const value = isNum(rpm)
      ? Math.min(1, Math.max(0, rpm / hud._barMax()))
      : 0;
    const quantized = Math.round(value * segs * 2) / (segs * 2); // only resend on half-segment steps
    const key = quantized + (hud.flash ? "f" : "");
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_value", [quantized]);
    state.c.uniform(state.ref, "u_flash", [hud.flash ? 1 : 0]);
  },
};
