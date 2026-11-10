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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    const max = hud._barMax(),
      red = hud.setting("redline");
    const midAt = t.bar.midAt === "shift" ? (red - 1500) / max : t.bar.midAt;
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_segs", [w.segments || 40]);
    c.uniform(ref, "u_low", rgb(t.bar.low));
    c.uniform(ref, "u_mid", rgb(t.bar.mid));
    c.uniform(ref, "u_high", rgb(t.bar.high));
    c.uniform(ref, "u_midAt", [midAt]);
    c.uniform(ref, "u_highAt", [(red - 500) / max]);
    c.uniform(ref, "u_track", rgba(t.track));
    c.uniform(ref, "u_flash", [0]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    const rpm = hud._raw("rpm");
    const segs = w.segments || 40;
    const v = isNum(rpm) ? Math.min(1, Math.max(0, rpm / hud._barMax())) : 0;
    const q = Math.round(v * segs * 2) / (segs * 2); // only resend on half-segment steps
    const key = q + (hud.flash ? "f" : "");
    if (!force && key === x.last) return;
    x.last = key;
    x.c.uniform(x.ref, "u_value", [q]);
    x.c.uniform(x.ref, "u_flash", [hud.flash ? 1 : 0]);
  },
};
