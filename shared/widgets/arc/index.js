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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_color", rgb(color(t, w.color || "arc")));
    c.uniform(ref, "u_track", rgba(t.track));
    c.uniform(ref, "u_width", [w.width || 7]);
    c.uniform(ref, "u_start", [
      ((w.start === undefined ? 225 : w.start) * Math.PI) / 180,
    ]);
    c.uniform(ref, "u_sweep", [
      ((w.sweep === undefined ? 270 : w.sweep) * Math.PI) / 180,
    ]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    const raw = hud._raw(w.signal);
    const v = isNum(raw)
      ? Math.min(1, Math.max(0, (raw - w.min) / (w.max - w.min)))
      : 0;
    const q = Math.round(v * 200) / 200;
    if (!force && q === x.last) return;
    x.last = q;
    x.c.uniform(x.ref, "u_value", [q]);
  },
};
