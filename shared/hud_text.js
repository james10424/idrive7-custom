"use strict";
/**
 * Draws text into a widget's RGBA buffer from the pre-baked bitmap fonts in
 * hud/fonts/ (made on the Mac by tools/bake_fonts.py; the car does no font
 * rasterizing). Each font is JSON: glyph metrics plus the atlas as one alpha
 * byte per pixel (base64). We tint the coverage with the requested colour.
 *
 *   drawText(boxW, boxH, text, { font, color, align, spacing, glow }) -> RGBA Buffer (boxW*boxH*4)
 *
 * align: 'left' | 'center' | 'right' within the box; x shifts the start (px). The text's cell top sits at
 * the box top (y = 0). spacing: extra px between characters. glow: 0..1, a soft
 * halo in the same colour under the text (the HUD look); 0 = none.
 * Output is straight (non-premultiplied) RGBA, as cluster-render image layers take it.
 */
const data = require("./hud_data");

const GLOW_MIN_RADIUS = 2; // px, the glow's least blur radius
const GLOW_SIZE_DIV = 24; // the glow's blur radius is the font size over this
const GLOW_PASSES = 2; // box blur passes for the glow

/**
 * One glyph's cell in a baked font atlas (hud/fonts/<name>.json).
 * @typedef {object} Glyph
 * @property {number} x atlas x
 * @property {number} y atlas y
 * @property {number} w
 * @property {number} h
 * @property {number} ox x offset from the pen
 * @property {number} advance
 */
/**
 * A loaded baked font.
 * @typedef {object} Font
 * @property {number} width atlas width
 * @property {Buffer} alpha one coverage byte per atlas pixel
 * @property {{ size: number, cellHeight: number, baseline: number, glyphs: Record<string, Glyph> }} metrics
 */
/**
 * Text drawing options.
 * @typedef {object} TextOpts
 * @property {string} font baked font name
 * @property {number[]} [color] [r, g, b, a] 0..255, default white
 * @property {number[]} [color2] the colour at the box bottom (a gradient)
 * @property {"left"|"center"|"right"} [align]
 * @property {number} [x] shifts the start, px
 * @property {number} [offsetY] px
 * @property {number} [spacing] extra px between characters
 * @property {number} [glow] 0..1, a soft halo under the text
 */

/** @type {Map<string, Font>} */
const loadedFonts = new Map();
/** @type {Set<string>} */
const warnedMissing = new Set();

/**
 * @param {string} name
 * @returns {Font}
 */
function loadFont(name) {
  if (loadedFonts.has(name)) return loadedFonts.get(name);
  const metrics = data.json("fonts/" + name + ".json");
  if (!metrics || !metrics.glyphs || !metrics.alpha)
    throw new Error('font "' + name + '" is missing from hud/fonts');
  const alpha = Buffer.from(metrics.alpha, "base64");
  if (alpha.length !== metrics.width * metrics.height)
    throw new Error('font "' + name + '": atlas size does not match');
  const font = {
    width: metrics.width,
    alpha,
    metrics: {
      size: metrics.size,
      cellHeight: metrics.cellHeight,
      baseline: metrics.baseline,
      glyphs: metrics.glyphs,
    },
  };
  loadedFonts.set(name, font);
  return font;
}

/**
 * @param {Font} font
 * @param {string} char
 * @returns {Glyph} the space (or an empty glyph) when missing
 */
function glyphOf(font, char) {
  const glyph = font.metrics.glyphs[char];
  if (glyph) return glyph;
  if (!warnedMissing.has(char)) {
    warnedMissing.add(char);
    console.warn("[hud_text] font has no glyph for " + JSON.stringify(char));
  }
  return (
    font.metrics.glyphs[" "] || { x: 0, y: 0, w: 0, h: 0, ox: 0, advance: 0 }
  );
}

/**
 * Width in px of `text` in `fontName` with `spacing`.
 * @param {string|number} text
 * @param {string} fontName
 * @param {number} [spacing]
 * @returns {number}
 */
function measure(text, fontName, spacing) {
  const font = loadFont(fontName);
  const chars = String(text).split("");
  let width = 0;
  chars.forEach((char, i) => {
    width +=
      glyphOf(font, char).advance + (i < chars.length - 1 ? spacing || 0 : 0);
  });
  return width;
}

/**
 * Coverage mask (boxW*boxH bytes) of the text laid out in the box.
 * @param {number} boxW
 * @param {number} boxH
 * @param {string|number} text
 * @param {TextOpts} opts
 * @returns {Buffer}
 */
function mask(boxW, boxH, text, opts) {
  const font = loadFont(opts.font);
  const spacing = opts.spacing || 0;
  const out = Buffer.alloc(boxW * boxH, 0);
  const width = measure(text, opts.font, spacing);
  let pen =
    (opts.x || 0) +
    (opts.align === "right"
      ? boxW - width
      : opts.align === "center"
        ? Math.round((boxW - width) / 2)
        : 0);
  const offY = opts.offsetY || 0;
  for (const char of String(text)) {
    const glyph = glyphOf(font, char);
    const x0 = Math.round(pen + glyph.ox); // spacing can be fractional: snap each glyph to a pixel
    for (let y = 0; y < glyph.h; y++) {
      const destY = y + offY;
      if (destY < 0 || destY >= boxH) continue;
      const srcRow = (glyph.y + y) * font.width + glyph.x;
      const dstRow = destY * boxW;
      for (let x = 0; x < glyph.w; x++) {
        const destX = x0 + x;
        if (destX < 0 || destX >= boxW) continue;
        const alpha = font.alpha[srcRow + x];
        if (alpha > out[dstRow + destX]) out[dstRow + destX] = alpha; // overlapping cells: keep the stronger ink
      }
    }
    pen += glyph.advance + spacing;
  }
  return out;
}

/**
 * Separable box blur on a coverage mask, `radius` px, `passes` times (~gaussian at 3).
 * @param {Buffer} src w*h bytes
 * @param {number} w
 * @param {number} h
 * @param {number} radius
 * @param {number} passes
 * @returns {Buffer}
 */
function blur(src, w, h, radius, passes) {
  let out = Buffer.from(src);
  let scratch = Buffer.alloc(out.length);
  const span = 2 * radius + 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      // horizontal
      const row = y * w;
      let sum = 0;
      for (let x = -radius; x <= radius; x++)
        sum += out[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        scratch[row + x] = (sum / span) | 0;
        sum +=
          out[row + Math.min(w - 1, x + radius + 1)] -
          out[row + Math.max(0, x - radius)];
      }
    }
    for (let x = 0; x < w; x++) {
      // vertical
      let sum = 0;
      for (let y = -radius; y <= radius; y++)
        sum += scratch[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = (sum / span) | 0;
        sum +=
          scratch[Math.min(h - 1, y + radius + 1) * w + x] -
          scratch[Math.max(0, y - radius) * w + x];
      }
    }
  }
  return out;
}

/**
 * The text as straight RGBA (boxW*boxH*4 bytes).
 * @param {number} boxW
 * @param {number} boxH
 * @param {string|number} text
 * @param {TextOpts} opts
 * @returns {Buffer}
 */
function drawText(boxW, boxH, text, opts) {
  return tint(mask(boxW, boxH, text, opts), boxW, boxH, opts);
}

/**
 * Colour a coverage mask (plus optional glow) into straight RGBA. opts: color, color2 (bottom, for a gradient), glow, font.
 * @param {Buffer} coverage coverage, boxW*boxH bytes
 * @param {number} boxW
 * @param {number} boxH
 * @param {TextOpts} opts
 * @returns {Buffer} boxW*boxH*4 bytes
 */
function tint(coverage, boxW, boxH, opts) {
  const color = opts.color || [255, 255, 255, 255];
  let halo = null;
  const glow = opts.glow || 0;
  if (glow > 0) {
    const radius = Math.max(
      GLOW_MIN_RADIUS,
      Math.round(loadFont(opts.font).metrics.size / GLOW_SIZE_DIV),
    );
    halo = blur(coverage, boxW, boxH, radius, GLOW_PASSES);
  }
  const out = Buffer.alloc(boxW * boxH * 4, 0);
  const alphaScale = color[3] / 255;
  const color2 = opts.color2; // optional: the colour at the bottom of the box (a top-to-bottom gradient)
  let rowC = color,
    row = -1;
  for (let i = 0; i < coverage.length; i++) {
    let alpha = coverage[i] / 255;
    if (halo) alpha = alpha + (1 - alpha) * (halo[i] / 255) * glow; // glyph over its own halo
    if (alpha <= 0) continue;
    if (color2) {
      const y = Math.floor(i / boxW);
      if (y !== row) {
        row = y;
        const frac = boxH > 1 ? y / (boxH - 1) : 0;
        rowC = [0, 1, 2].map((j) =>
          Math.round(color[j] + (color2[j] - color[j]) * frac),
        );
      }
    }
    const offset = i * 4;
    out[offset] = rowC[0];
    out[offset + 1] = rowC[1];
    out[offset + 2] = rowC[2];
    out[offset + 3] = Math.round(alpha * alphaScale * 255);
  }
  return out;
}

module.exports = { drawText, mask, tint, measure, loadFont };
