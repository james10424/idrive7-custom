"use strict";
/**
 * The "mtach" widget: an effect layer.
 */
const { isNum, rgb } = require("../../engine/util");
const MTACH = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the M rev bar: "side" left|right, "max" rpm, and in target px for the LEFT bar "y0" (0 rpm), "y8" (max), "ym" (the bend), "xm" (outer edge x at the bend; the right bar gives its own, mirrored), "kTop" / "kBot" (x per y px above / below the bend), "round", "wBot" / "wTop" / "wBend"`;

module.exports = {
  type: "mtach",
  fields: ["side", "y0", "y8", "ym", "xm", "kTop", "kBot", "wBot", "wTop"],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return MTACH;
  },
  shaders: { mtach: MTACH },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    const max = widget.max || 8000,
      [redFrom, orange] = hud._redMarks(max);
    const right = widget.side === "right";
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_side", [right ? 1 : -1]);
    client.uniform(ref, "u_geoA", [
      widget.y0 - widget.y,
      widget.y8 - widget.y,
      widget.ym - widget.y,
      right ? widget.x + widget.w - widget.xm : widget.xm - widget.x,
    ]);
    client.uniform(ref, "u_geoB", [
      widget.kTop,
      widget.kBot,
      widget.round || 40,
    ]);
    client.uniform(ref, "u_wid", [widget.wBot, widget.wTop, widget.wBend || 0]);
    client.uniform(ref, "u_ticks", [max / 1000]);
    client.uniform(ref, "u_orange", [orange]);
    client.uniform(ref, "u_redFrom", [redFrom]);
    client.uniform(ref, "u_red", rgb(theme.hot));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    const rpm = hud._raw("rpm"),
      shift = hud._shift();
    const value = isNum(rpm)
      ? Math.min(1, Math.max(0, rpm / (widget.max || 8000)))
      : 0;
    const key = Math.round(value * 600) + "|" + shift.now;
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_value", [value]);
    state.c.uniform(state.ref, "u_shiftNow", [shift.now ? 1 : 0]);
  },
};
