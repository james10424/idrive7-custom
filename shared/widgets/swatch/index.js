"use strict";
/**
 * The "swatch" widget: an effect layer.
 */
const { SWATCH, SWATCH_STEPS } = require("./calibration");

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
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref;
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_n", [widget.steps || SWATCH_STEPS]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {},
};
