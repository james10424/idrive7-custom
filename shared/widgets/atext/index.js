"use strict";
/**
 * The "atext" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgba, TEXT_MS } = require("../../engine/util");
const ATEXT = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} AtextState
 * @property {import("../../engine/app").GlyphAtlas} [atlas]
 * @property {number} [cells]
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer (atext/shader.js): text drawn by the GPU from a glyph atlas, the probe for the path that needs no pixel writes. The font's glyphs go up once per connection as an R8 asset (one byte a pixel, not a layer, shared by every atext widget on that font); the widget is "cells" equal cells across its width ("w" / cells wide each; the glyphs keep their shape when w = cells x the font's widest advance and h = its cell height, logged at creation), and a new value is one uniform message of glyph codes. "text" tokens as text, "font", "color" role, "align" left | right | center. Up to 32 cells; only the characters the font has.`;

/**
 * The glyph codes of a text in an atlas widget's cells, aligned; -1 is an empty cell.
 * @param {WidgetState & AtextState} x
 * @param {*} s
 * @returns {number[]} 32 codes
 */
function atlasCodes(x, s) {
  const a = x.atlas,
    n = x.cells,
    text = String(s).slice(0, n);
  const pad = n - text.length,
    w = x.w;
  const lead =
    w.align === "right" ? pad : w.align === "center" ? Math.floor(pad / 2) : 0;
  const codes = [];
  for (let i = 0; i < 32; i++) {
    const j = i - lead;
    const ch = j >= 0 && j < text.length ? text[j] : null;
    const k = ch === null ? -1 : a.chars.indexOf(ch);
    codes.push(i < n && ch !== null ? (k < 0 ? a.chars.indexOf(" ") : k) : -1);
  }
  return codes;
}

module.exports = {
  type: "atext",
  fields: ["text", "font"],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return ATEXT;
  },
  shaders: { atext: ATEXT },
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState & AtextState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    const a = hud._atlas(w.font, x.ci);
    x.atlas = a;
    x.cells = Math.max(
      1,
      Math.min(
        32,
        isNum(w.cells) ? Math.floor(w.cells) : Math.floor(w.w / a.cellW),
      ),
    );
    c.bind(ref, "u_font", a.ref);
    c.uniform(ref, "u_cells", [x.cells]);
    c.uniform(ref, "u_grid", [a.cols, a.rows]);
    c.uniform(ref, "u_color", rgba(color(t, w.color || "fg")));
    c.uniform(ref, "u_text", atlasCodes(x, ""), { type: "vec4" });
    if (w.w !== x.cells * a.cellW || w.h !== a.cellH) {
      hud.log.info(
        'widget "' +
          w.id +
          '": ' +
          x.cells +
          " cells of " +
          (w.w / x.cells).toFixed(1) +
          "x" +
          w.h +
          " px; the glyphs keep their shape at w " +
          x.cells * a.cellW +
          ", h " +
          a.cellH,
      );
    }
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & AtextState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    if (!force && now - x.lastPaint < (w.rate || TEXT_MS)) return;
    const s = hud._resolve(w.text);
    if (!force && s === x.last) return;
    x.last = s;
    x.lastPaint = now;
    x.c.uniform(x.ref, "u_text", atlasCodes(x, s), { type: "vec4" });
  },
};
