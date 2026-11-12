"use strict";
/**
 * The "gridlabels" widget: an image layer (pixels).
 */
const textRaster = require("../../hud_text");

const LABEL_STEP_PX = 100; // default label spacing
const LABEL_PAD_PX = 2; // each label's inset from its grid point, and its extra width
/** @type {number[]} */
const LABEL_RGBA = [255, 230, 0, 255]; // the labels: yellow

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `calibration: image layer, "x/y" at every "step" px (only the labels are uploaded)`;

/**
 * "x/y" at every step, uploaded as small rects (not the whole, mostly empty, image).
 * @param {HudApp} hud
 * @param {WidgetState} state
 * @returns {void}
 */
function paint(hud, state) {
  const widget = state.w,
    width = widget.w,
    height = widget.h,
    step = widget.step || LABEL_STEP_PX,
    font = widget.font;
  const cell = textRaster.loadFont(font).metrics.cellHeight;
  const rects = [],
    parts = [];
  for (let gy = 0; gy < height; gy += step) {
    for (let gx = 0; gx < width; gx += step) {
      const label = widget.x + gx + "/" + (widget.y + gy);
      const labelW = Math.min(
        width - gx - LABEL_PAD_PX,
        textRaster.measure(label, font, 0) + LABEL_PAD_PX,
      );
      const labelH = Math.min(height - gy - LABEL_PAD_PX, cell);
      if (labelW <= 0 || labelH <= 0) continue;
      const buf = textRaster.drawText(labelW, labelH, label, {
        font,
        color: LABEL_RGBA,
      });
      rects.push({ x: gx + LABEL_PAD_PX, y: gy + LABEL_PAD_PX, w: labelW, h: labelH });
      parts.push(buf);
    }
  }
  hud._blit(state, rects, Buffer.concat(parts));
}

module.exports = {
  type: "gridlabels",
  fields: ["font"],
  docs: DOCS,
  image: true,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    paint(hud, state);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {},
};
