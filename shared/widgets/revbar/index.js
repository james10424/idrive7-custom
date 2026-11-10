"use strict";
/**
 * The "revbar" widget: an effect layer.
 */
const { isNum, rgb, rgba } = require("../../engine/util");
const REVBAR = require("./shader");

/** @typedef {import("../../hud").Widget} Widget */
/** @typedef {import("../../hud").WidgetState} WidgetState */
/** @typedef {import("../../hud").HudApp} HudApp */

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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_top", [w.top || 8]);
    c.uniform(ref, "u_barH", [w.barH]);
    c.uniform(ref, "u_slant", [w.slant || 12]);
    c.uniform(ref, "u_max", [hud._barMax(w)]);
    c.uniform(ref, "u_red", [hud.setting("redline")]);
    c.uniform(ref, "u_from", rgb(t.rev.from));
    c.uniform(ref, "u_to", rgb(t.rev.to));
    c.uniform(ref, "u_hot", rgb(t.hot));
    c.uniform(ref, "u_track", rgba(t.track));
    c.uniform(ref, "u_tick", rgba(t.dim));
    c.uniform(ref, "u_fg", rgba(t.fg));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const rpm = hud._raw("rpm"),
      sp = hud._shift();
    const v = isNum(rpm) ? Math.round(Math.max(0, rpm) / 10) * 10 : 0;
    const peak = Math.round(hud.score.peak / 10) * 10;
    const key = v + "|" + sp.rpm + "|" + peak + "|" + sp.now;
    if (!force && key === x.last) return;
    x.last = key;
    x.c.uniform(x.ref, "u_value", [v]);
    x.c.uniform(x.ref, "u_shift", [sp.rpm]);
    x.c.uniform(x.ref, "u_peak", [peak]);
    x.c.uniform(x.ref, "u_shiftNow", [sp.now ? 1 : 0]);
  },
};
