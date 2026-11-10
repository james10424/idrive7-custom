"use strict";
/**
 * The "stripe" widget: an image layer (pixels).
 */
const { M_STRIPE } = require("../../hud_themes");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `image layer; the M tricolour stripe`;

/**
 * Paints the M tricolour stripe.
 * @param {HudApp} hud
 * @param {WidgetState} x
 * @returns {void}
 */
function paint(hud, x) {
  const w = x.w,
    buf = Buffer.alloc(w.w * w.h * 4, 0);
  for (let px = 0; px < w.w; px++) {
    const c = M_STRIPE[Math.min(2, Math.floor((px * 3) / w.w))];
    for (let py = 0; py < w.h; py++)
      c.forEach((v, i) => {
        buf[(py * w.w + px) * 4 + i] = v;
      });
  }
  hud._blit(x, null, buf);
}

module.exports = {
  type: "stripe",
  fields: [],
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
