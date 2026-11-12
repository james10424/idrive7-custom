"use strict";
/**
 * The "arc" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgb, rgba } = require("../../engine/util");
const ARC = require("./shader");

const ARC_WIDTH_PX = 7; // the arc's default line width
const ARC_START_DEG = 225; // the default start, clockwise from 12 o'clock
const ARC_SWEEP_DEG = 270; // the default sweep
const ARC_STEPS = 200; // the value is resent only in steps of 1/200 of the arc

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
    client.uniform(ref, "u_width", [widget.width || ARC_WIDTH_PX]);
    client.uniform(ref, "u_start", [
      ((widget.start === undefined ? ARC_START_DEG : widget.start) * Math.PI) / 180,
    ]);
    client.uniform(ref, "u_sweep", [
      ((widget.sweep === undefined ? ARC_SWEEP_DEG : widget.sweep) * Math.PI) / 180,
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
    const quantized = Math.round(value * ARC_STEPS) / ARC_STEPS;
    if (!force && quantized === state.last) return;
    state.last = quantized;
    state.c.uniform(state.ref, "u_value", [quantized]);
  },
};
