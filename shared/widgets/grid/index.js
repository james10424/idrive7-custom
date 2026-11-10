"use strict";
/**
 * The "grid" widget: an effect layer.
 */
const { rgba } = require("../../engine/util");
const GRID = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `calibration: effect layer of lines every "step" px (brighter every "major" steps)`;

module.exports = {
  type: "grid",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return GRID;
  },
  shaders: { grid: GRID },
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref;
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_step", [w.step || 50]);
    c.uniform(ref, "u_major", [w.major || 2]);
    c.uniform(ref, "u_minor", rgba([255, 255, 255, 90]));
    c.uniform(ref, "u_majorC", rgba([0, 255, 140, 255]));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {},
};
