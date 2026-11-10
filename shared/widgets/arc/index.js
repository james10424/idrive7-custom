"use strict";
/**
 * The "arc" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgb, rgba } = require("../../engine/util");
const ARC = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; arc/shader.js, lit by a signal between min and max. Also "start" and "sweep" in degrees (clockwise from 12 o'clock; negative = anticlockwise).`;

module.exports = {
  type: "arc",
  fields: ["signal", "min", "max"],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return ARC;
  },
  shaders: { arc: ARC },
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
    client.uniform(ref, "u_color", rgb(color(theme, widget.color || "arc")));
    client.uniform(ref, "u_track", rgba(theme.track));
    client.uniform(ref, "u_width", [widget.width || 7]);
    client.uniform(ref, "u_start", [
      ((widget.start === undefined ? 225 : widget.start) * Math.PI) / 180,
    ]);
    client.uniform(ref, "u_sweep", [
      ((widget.sweep === undefined ? 270 : widget.sweep) * Math.PI) / 180,
    ]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    const raw = hud._raw(widget.signal);
    const value = isNum(raw)
      ? Math.min(1, Math.max(0, (raw - widget.min) / (widget.max - widget.min)))
      : 0;
    const quantized = Math.round(value * 200) / 200;
    if (!force && quantized === state.last) return;
    state.last = quantized;
    state.c.uniform(state.ref, "u_value", [quantized]);
  },
};
