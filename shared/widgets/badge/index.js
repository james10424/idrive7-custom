"use strict";
/**
 * The "badge" widget: an image layer (pixels).
 */
const { VERDICT } = require("../../hud_themes");
const textRaster = require("../../hud_text");
const { TEXT_MS } = require("../../engine/util");

/** @typedef {import("../../hud").Widget} Widget */
/** @typedef {import("../../hud").WidgetState} WidgetState */
/** @typedef {import("../../hud").HudApp} HudApp */

const DOCS = `image layer; a rounded tag with text: "tone" verdict (the last shift's grade colour) or cold. Updates send only the one rectangle around the pixels that changed since the last paint.`;

/**
 * A rounded tag: fill in the tone colour (bright for a fresh grade), text centred on it. Empty text: nothing.
 * @param {HudApp} hud
 * @param {Widget} w
 * @param {string} s
 * @param {number[]} tone RGBA
 * @param {boolean} fresh
 * @returns {Buffer}
 */
function paint(hud, w, s, tone, fresh) {
  const W = w.w,
    H = w.h,
    buf = Buffer.alloc(W * H * 4, 0);
  if (!s) return buf;
  const r = Math.min(6, H / 2),
    fillA = fresh ? 0.45 : 0.2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // rounded-rect coverage, 1 px soft edge
      const qx = Math.max(Math.abs(x + 0.5 - W / 2) - (W / 2 - r), 0),
        qy = Math.max(Math.abs(y + 0.5 - H / 2) - (H / 2 - r), 0);
      const cov = Math.min(
        1,
        Math.max(0, r + 0.5 - Math.sqrt(qx * qx + qy * qy)),
      );
      if (cov <= 0) continue;
      const o = (y * W + x) * 4;
      buf[o] = tone[0];
      buf[o + 1] = tone[1];
      buf[o + 2] = tone[2];
      buf[o + 3] = Math.round(255 * fillA * cov);
    }
  }
  const font = textRaster.loadFont(w.font);
  const ty = Math.round((H - font.metrics.cellHeight) / 2);
  const m = textRaster.mask(W, H, s, {
    font: w.font,
    align: "center",
    spacing: w.spacing,
    offsetY: ty,
  });
  const tc = fresh ? hud.theme.fg : tone;
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    const a = m[i] / 255,
      o = i * 4,
      ba = buf[o + 3] / 255;
    const outA = a + ba * (1 - a);
    for (let c = 0; c < 3; c++)
      buf[o + c] = Math.round((tc[c] * a + buf[o + c] * ba * (1 - a)) / outA);
    buf[o + 3] = Math.round(outA * 255);
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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {},
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    if (!force && now - x.lastPaint < TEXT_MS) return;
    const s = hud._resolve(w.text);
    let tone = VERDICT.COLD,
      fresh = false;
    if (w.tone === "verdict" && hud.score.last) {
      tone = VERDICT[hud.score.last.verdict] || hud.theme.fg;
      fresh = now - hud.score.last.at < 2500;
    }
    const key = s + "|" + tone + "|" + fresh;
    if (!force && key === x.last) return;
    x.last = key;
    x.lastPaint = now;
    hud._blitDiff(x, paint(hud, w, s, tone, fresh));
  },
};
