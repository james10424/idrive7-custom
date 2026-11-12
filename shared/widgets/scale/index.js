"use strict";
/**
 * The "scale" widget: an image layer (pixels).
 */
const { color } = require("../../hud_themes");
const textRaster = require("../../hud_text");

const RPM_PER_LABEL = 1000; // one number per thousand rpm

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `image layer; the shift bar's rpm numbers (0 .. bar max / 1000), evenly spread. "over" as revbar; "redFrom": true draws the numbers from the redline on in red.`;

/**
 * Paints the rpm numbers (red from the redline with "redFrom").
 * @param {HudApp} hud
 * @param {WidgetState} state
 * @returns {void}
 */
function paint(hud, state) {
  const widget = state.w,
    labelCount = hud._barMax(widget) / RPM_PER_LABEL + 1,
    red = hud.setting("redline");
  const mask = Buffer.alloc(widget.w * widget.h, 0),
    hot = Buffer.alloc(widget.w * widget.h, 0);
  for (let i = 0; i < labelCount; i++) {
    const label = String(i);
    const labelW = textRaster.measure(label, widget.font, 0);
    const cx = (i / (labelCount - 1)) * widget.w;
    const left = Math.round(
      Math.max(0, Math.min(widget.w - labelW, cx - labelW / 2)),
    );
    const one = textRaster.mask(widget.w, widget.h, label, {
      font: widget.font,
      x: left,
    });
    const into = widget.redFrom && i * RPM_PER_LABEL >= red ? hot : mask;
    for (let k = 0; k < mask.length; k++)
      if (one[k] > into[k]) into[k] = one[k];
  }
  const buf = textRaster.tint(mask, widget.w, widget.h, {
    color: color(hud.theme, widget.color || "dim"),
    font: widget.font,
  });
  if (widget.redFrom) {
    const hotBuf = textRaster.tint(hot, widget.w, widget.h, {
      color: hud.theme.hot,
      font: widget.font,
    });
    for (let k = 0; k < hot.length; k++)
      if (hot[k]) hotBuf.copy(buf, k * 4, k * 4, k * 4 + 4);
  }
  hud._blit(state, null, buf);
}

module.exports = {
  type: "scale",
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
