"use strict";
/**
 * The "odo" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgba } = require("../../engine/util");
const ODO = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} OdoState
 * @property {import("../../engine/app").GlyphAtlas} [atlas]
 * @property {number} [drums]
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer (odo/shader.js): a mechanical odometer, "drums" (6) digit drums of "font"'s glyph atlas (r_gl), "color" role, "gap" px between drums (2), "frame" px (1); the car's KombiIF mileageKilometre in the units setting's unit, the last drum turning with the distance (from the speed between whole km) and the others rolling over as the real gears do. Blank drums without a reading.`;

module.exports = {
  type: "odo",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return ODO;
  },
  shaders: { odo: ODO },
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState & OdoState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    const a = hud._atlas(w.font || "r_gl", x.ci);
    x.atlas = a;
    const dig = "0123456789"
      .split("")
      .map((ch) => Math.max(0, a.chars.indexOf(ch)))
      .concat([0, 0]);
    x.drums = Math.max(1, Math.min(8, w.drums || 6));
    c.bind(ref, "u_font", a.ref);
    c.uniform(ref, "u_grid", [a.cols, a.rows]);
    c.uniform(ref, "u_dig", dig, { type: "vec4" });
    c.uniform(ref, "u_color", rgba(color(t, w.color || "fg")));
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_odo", [
      x.drums,
      isNum(w.gap) ? w.gap : 2,
      0,
      isNum(w.frame) ? w.frame : 1,
    ]);
    c.uniform(ref, "u_drum", [0, 0, 0, 0, 0, 0, 0, 0], { type: "vec4" });
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & OdoState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    // the drums of a mechanical odometer in the units setting's unit: the last turns with the distance, each other
    // rolls over only through its lower neighbours' last unit (9 -> 0), as the gears of a real one
    const km = hud._odometer(now),
      us = hud.setting("units") === "us";
    const n = x.drums,
      drums = [0, 0, 0, 0, 0, 0, 0, 0];
    if (isNum(km)) {
      const v = (us ? km * 0.621371 : km) % Math.pow(10, n);
      for (let k = 0; k < n; k++) {
        const p = Math.pow(10, k),
          lower = v % p;
        const roll = k === 0 ? v % 1 : Math.max(0, lower - (p - 1));
        drums[n - 1 - k] =
          Math.round(((Math.floor(v / p) % 10) + roll) * 50) / 50;
      }
    }
    const key = isNum(km) + "|" + drums.join(",");
    if (!force && key === x.last) return;
    x.last = key;
    x.c.uniform(x.ref, "u_odo", [
      n,
      isNum(w.gap) ? w.gap : 2,
      isNum(km) ? 1 : 0,
      isNum(w.frame) ? w.frame : 1,
    ]);
    x.c.uniform(x.ref, "u_drum", drums, { type: "vec4" });
  },
};
