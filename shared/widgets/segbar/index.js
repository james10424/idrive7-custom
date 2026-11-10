"use strict";
/**
 * The "segbar" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgba } = require("../../engine/util");
const SEGBAR = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {InstanceType<typeof import("../../engine/app")>} HudApp */

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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_segs", [w.max]);
    c.uniform(ref, "u_on", rgba(color(t, w.color || "hot")));
    c.uniform(ref, "u_offC", rgba(color(t, "track")));
    c.uniform(ref, "u_slant", [w.slant || 0]);
    c.uniform(ref, "u_gap", [isNum(w.gap) ? w.gap : 8]);
    c.uniform(ref, "u_hotSeg", [-1]);
    c.uniform(ref, "u_hotC", rgba(color(t, w.hotColor || "hot")));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    let v = hud._raw(w.signal);
    if (isNum(v) && Array.isArray(w.range) && w.range.length === 2)
      v = ((v - w.range[0]) / (w.range[1] - w.range[0])) * w.max;
    const lit = isNum(v) ? Math.max(0, Math.min(w.max, Math.round(v))) : 0;
    const hot = w.hotWhen === "kickdown" && hud._kickdown() && lit === w.max; // the last segment in "hotColor"
    const key = lit + (hot ? "h" : "");
    if (!force && key === x.last) return;
    x.last = key;
    x.c.uniform(x.ref, "u_lit", [lit]);
    x.c.uniform(x.ref, "u_hotSeg", [hot ? w.max - 1 : -1]);
  },
};
