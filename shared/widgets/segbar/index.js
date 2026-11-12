"use strict";
/**
 * The "segbar" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgba } = require("../../engine/util");
const SEGBAR = require("./shader");

const SEGBAR_GAP_PX = 8; // default gap between segments

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; "max" segments, the first round(signal) lit (e.g. "setupLevel:engine"), "slant" px, "gap" px between segments (8), "hotWhen": "kickdown" draws the last segment in "hotColor" (hot) while the pedal is in kickdown and the bar is full; "range" [lo, hi] maps the signal from that span onto 0..max (e.g. "boost" over [0, 1.5] bar, "batt12" over [0, 100] %)`;

module.exports = {
  type: "segbar",
  fields: ["signal", "max"],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return SEGBAR;
  },
  shaders: { segbar: SEGBAR },
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
    client.uniform(ref, "u_segs", [widget.max]);
    client.uniform(ref, "u_on", rgba(color(theme, widget.color || "hot")));
    client.uniform(ref, "u_offC", rgba(color(theme, "track")));
    client.uniform(ref, "u_slant", [widget.slant || 0]);
    client.uniform(ref, "u_gap", [isNum(widget.gap) ? widget.gap : SEGBAR_GAP_PX]);
    client.uniform(ref, "u_hotSeg", [-1]);
    client.uniform(ref, "u_hotC", rgba(color(theme, widget.hotColor || "hot")));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    let value = hud._raw(widget.signal);
    if (
      isNum(value) &&
      Array.isArray(widget.range) &&
      widget.range.length === 2
    )
      value =
        ((value - widget.range[0]) / (widget.range[1] - widget.range[0])) *
        widget.max;
    const lit = isNum(value)
      ? Math.max(0, Math.min(widget.max, Math.round(value)))
      : 0;
    const hot =
      widget.hotWhen === "kickdown" && hud._kickdown() && lit === widget.max; // the last segment in "hotColor"
    const key = lit + (hot ? "h" : "");
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_lit", [lit]);
    state.c.uniform(state.ref, "u_hotSeg", [hot ? widget.max - 1 : -1]);
  },
};
