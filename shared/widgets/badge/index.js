"use strict";
/**
 * The "badge" widget: an image layer (pixels).
 */
const { VERDICT } = require("../../hud_themes");
const textRaster = require("../../hud_text");
const { TEXT_MS } = require("../../engine/util");

const BADGE_RADIUS_PX = 6; // corner radius (at most half the height)
const BADGE_FILL_FRESH = 0.45; // the fill's alpha for a fresh grade
const BADGE_FILL = 0.2; // the fill's alpha otherwise
const BADGE_FRESH_MS = 2500; // a grade stays fresh (bright) this long after the shift

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `image layer; a rounded tag with text: "tone" verdict (the last shift's grade colour) or cold. Updates send only the one rectangle around the pixels that changed since the last paint.`;

/**
 * A rounded tag: fill in the tone colour (bright for a fresh grade), text centred on it. Empty text: nothing.
 * @param {HudApp} hud
 * @param {Widget} widget
 * @param {string} text
 * @param {number[]} tone RGBA
 * @param {boolean} fresh
 * @returns {Buffer}
 */
function paint(hud, widget, text, tone, fresh) {
  const width = widget.w,
    height = widget.h,
    buf = Buffer.alloc(width * height * 4, 0);
  if (!text) return buf;
  const radius = Math.min(BADGE_RADIUS_PX, height / 2),
    fillA = fresh ? BADGE_FILL_FRESH : BADGE_FILL;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // rounded-rect coverage, 1 px soft edge
      const edgeX = Math.max(
          Math.abs(x + 0.5 - width / 2) - (width / 2 - radius),
          0,
        ),
        edgeY = Math.max(
          Math.abs(y + 0.5 - height / 2) - (height / 2 - radius),
          0,
        );
      const cov = Math.min(
        1,
        Math.max(0, radius + 0.5 - Math.sqrt(edgeX * edgeX + edgeY * edgeY)),
      );
      if (cov <= 0) continue;
      const offset = (y * width + x) * 4;
      buf[offset] = tone[0];
      buf[offset + 1] = tone[1];
      buf[offset + 2] = tone[2];
      buf[offset + 3] = Math.round(255 * fillA * cov);
    }
  }
  const font = textRaster.loadFont(widget.font);
  const textY = Math.round((height - font.metrics.cellHeight) / 2);
  const mask = textRaster.mask(width, height, text, {
    font: widget.font,
    align: "center",
    spacing: widget.spacing,
    offsetY: textY,
  });
  const textColor = fresh ? hud.theme.fg : tone;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const alpha = mask[i] / 255,
      offset = i * 4,
      bgAlpha = buf[offset + 3] / 255;
    const outA = alpha + bgAlpha * (1 - alpha);
    for (let channel = 0; channel < 3; channel++)
      buf[offset + channel] = Math.round(
        (textColor[channel] * alpha +
          buf[offset + channel] * bgAlpha * (1 - alpha)) /
          outA,
      );
    buf[offset + 3] = Math.round(outA * 255);
  }
  return buf;
}

module.exports = {
  type: "badge",
  fields: ["text", "font", "tone"],
  docs: DOCS,
  image: true,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {},
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    if (!force && now - state.lastPaint < TEXT_MS) return;
    const text = hud._resolve(widget.text);
    let tone = VERDICT.COLD,
      fresh = false;
    if (widget.tone === "verdict" && hud.score.last) {
      tone = VERDICT[hud.score.last.verdict] || hud.theme.fg;
      fresh = now - hud.score.last.at < BADGE_FRESH_MS;
    }
    const key = text + "|" + tone + "|" + fresh;
    if (!force && key === state.last) return;
    state.last = key;
    state.lastPaint = now;
    hud._blitDiff(state, paint(hud, widget, text, tone, fresh));
  },
};
