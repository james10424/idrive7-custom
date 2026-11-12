"use strict";
/**
 * The "grid" widget: an effect layer.
 */
const { rgba } = require("../../engine/util");
const GRID = require("./shader");

const GRID_STEP_PX = 50; // default line spacing
const GRID_MAJOR_EVERY = 2; // default: every second line is a major one
/** @type {number[]} */
const GRID_MINOR_RGBA = [255, 255, 255, 90]; // the minor lines: faint white
/** @type {number[]} */
const GRID_MAJOR_RGBA = [0, 255, 140, 255]; // the major lines: green

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
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref;
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_step", [widget.step || GRID_STEP_PX]);
    client.uniform(ref, "u_major", [widget.major || GRID_MAJOR_EVERY]);
    client.uniform(ref, "u_minor", rgba(GRID_MINOR_RGBA));
    client.uniform(ref, "u_majorC", rgba(GRID_MAJOR_RGBA));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {},
};
