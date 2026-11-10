"use strict";
/**
 * The "swatchimg" widget: an image layer (pixels).
 */
const { swatchImage } = require("./calibration");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {InstanceType<typeof import("../../engine/app")>} HudApp */

const DOCS = `calibration: image layer, the identical picture painted into pixels (calibration.js swatchImage), so a photo of the two strips shows how the effect and image paths differ`;

module.exports = {
  type: "swatchimg",
  fields: [],
  docs: DOCS,
  image: true,
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    hud._blit(x, null, swatchImage(w.w, w.h, w.steps || 11));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {},
};
