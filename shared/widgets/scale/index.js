"use strict";
/**
 * The "scale" widget: an image layer (pixels).
 */
const { color } = require("../../hud_themes");
const textRaster = require("../../hud_text");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `image layer; the shift bar's rpm numbers (0 .. bar max / 1000), evenly spread. "over" as revbar; "redFrom": true draws the numbers from the redline on in red.`;

/**
 * Paints the rpm numbers (red from the redline with "redFrom").
 * @param {HudApp} hud
 * @param {WidgetState} x
 * @returns {void}
 */
function paint(hud, x) {
  const w = x.w,
    n = hud._barMax(w) / 1000 + 1,
    red = hud.setting("redline");
  const m = Buffer.alloc(w.w * w.h, 0),
    hot = Buffer.alloc(w.w * w.h, 0);
  for (let i = 0; i < n; i++) {
    const label = String(i);
    const lw = textRaster.measure(label, w.font, 0);
    const cx = (i / (n - 1)) * w.w;
    const left = Math.round(Math.max(0, Math.min(w.w - lw, cx - lw / 2)));
    const one = textRaster.mask(w.w, w.h, label, { font: w.font, x: left });
    const into = w.redFrom && i * 1000 >= red ? hot : m;
    for (let k = 0; k < m.length; k++) if (one[k] > into[k]) into[k] = one[k];
  }
  const buf = textRaster.tint(m, w.w, w.h, {
    color: color(hud.theme, w.color || "dim"),
    font: w.font,
  });
  if (w.redFrom) {
    const hb = textRaster.tint(hot, w.w, w.h, {
      color: hud.theme.hot,
      font: w.font,
    });
    for (let k = 0; k < hot.length; k++)
      if (hot[k]) hb.copy(buf, k * 4, k * 4, k * 4 + 4);
  }
  hud._blit(x, null, buf);
}

module.exports = {
  type: "scale",
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
