"use strict";
/**
 * The "swatch" widget: an effect layer.
 */
const { SWATCH } = require("./calibration");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `calibration: effect layer (calibration.js SWATCH), "steps" (11) grey steps 0..1 over the top half, four dark test colours over the bottom half`;

module.exports = {
  type: "swatch",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return SWATCH;
  },
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref;
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_n", [w.steps || 11]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {},
};
