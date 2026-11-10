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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    const max = w.max || 8000,
      [redFrom, orange] = hud._redMarks(max);
    const right = w.side === "right";
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_side", [right ? 1 : -1]);
    c.uniform(ref, "u_geoA", [
      w.y0 - w.y,
      w.y8 - w.y,
      w.ym - w.y,
      right ? w.x + w.w - w.xm : w.xm - w.x,
    ]);
    c.uniform(ref, "u_geoB", [w.kTop, w.kBot, w.round || 40]);
    c.uniform(ref, "u_wid", [w.wBot, w.wTop, w.wBend || 0]);
    c.uniform(ref, "u_ticks", [max / 1000]);
    c.uniform(ref, "u_orange", [orange]);
    c.uniform(ref, "u_redFrom", [redFrom]);
    c.uniform(ref, "u_red", rgb(t.hot));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    const rpm = hud._raw("rpm"),
      sp = hud._shift();
    const v = isNum(rpm) ? Math.min(1, Math.max(0, rpm / (w.max || 8000))) : 0;
    const key = Math.round(v * 600) + "|" + sp.now;
    if (!force && key === x.last) return;
    x.last = key;
    x.c.uniform(x.ref, "u_value", [v]);
    x.c.uniform(x.ref, "u_shiftNow", [sp.now ? 1 : 0]);
  },
};
