"use strict";
/**
 * The "swatchimg" widget: an image layer (pixels).
 */
const { swatchImage, SWATCH_STEPS } = require("./calibration");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `calibration: image layer, the identical picture painted into pixels (calibration.js swatchImage), so a photo of the two strips shows how the effect and image paths differ`;

module.exports = {
  type: "swatchimg",
  fields: [],
  docs: DOCS,
  image: true,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    hud._blit(state, null, swatchImage(widget.w, widget.h, widget.steps || SWATCH_STEPS));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {},
};
