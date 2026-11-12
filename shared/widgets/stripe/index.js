"use strict";
/**
 * The "stripe" widget: an image layer (pixels).
 */
const { M_STRIPE } = require("../../hud_themes");

const STRIPE_BANDS = 3; // the tricolour's bands, side by side

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `image layer; the M tricolour stripe`;

/**
 * Paints the M tricolour stripe.
 * @param {HudApp} hud
 * @param {WidgetState} state
 * @returns {void}
 */
function paint(hud, state) {
  const widget = state.w,
    buf = Buffer.alloc(widget.w * widget.h * 4, 0);
  for (let px = 0; px < widget.w; px++) {
    const stripeColor = M_STRIPE[
      Math.min(STRIPE_BANDS - 1, Math.floor((px * STRIPE_BANDS) / widget.w))
    ];
    for (let py = 0; py < widget.h; py++)
      stripeColor.forEach((channel, i) => {
        buf[(py * widget.w + px) * 4 + i] = channel;
      });
  }
  hud._blit(state, null, buf);
}

module.exports = {
  type: "stripe",
  fields: [],
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
