"use strict";
/**
 * The "gridlabels" widget: an image layer (pixels).
 */
const textRaster = require("../../hud_text");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {InstanceType<typeof import("../../engine/app")>} HudApp */

const DOCS = `calibration: image layer, "x/y" at every "step" px (only the labels are uploaded)`;

/**
 * "x/y" at every step, uploaded as small rects (not the whole, mostly empty, image).
 * @param {HudApp} hud
 * @param {WidgetState} x
 * @returns {void}
 */
function paint(hud, x) {
  const w = x.w,
    W = w.w,
    H = w.h,
    step = w.step || 100,
    font = w.font;
  const cell = textRaster.loadFont(font).metrics.cellHeight;
  const rects = [],
    parts = [];
  for (let gy = 0; gy < H; gy += step) {
    for (let gx = 0; gx < W; gx += step) {
      const label = w.x + gx + "/" + (w.y + gy);
      const lw = Math.min(W - gx - 2, textRaster.measure(label, font, 0) + 2);
      const lh = Math.min(H - gy - 2, cell);
      if (lw <= 0 || lh <= 0) continue;
      const buf = textRaster.drawText(lw, lh, label, {
        font,
        color: [255, 230, 0, 255],
      });
      rects.push({ x: gx + 2, y: gy + 2, w: lw, h: lh });
      parts.push(buf);
    }
  }
  hud._blit(x, rects, Buffer.concat(parts));
}

module.exports = {
  type: "gridlabels",
  fields: ["font"],
  docs: DOCS,
  image: true,
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    paint(hud, x);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {},
};
