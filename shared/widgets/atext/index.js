"use strict";
/**
 * The "atext" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgba, TEXT_MS } = require("../../engine/util");
const ATEXT = require("./shader");

const MAX_CELLS = 32; // the shader's glyph cells (u_text, eight vec4)

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
 * @param {WidgetState & AtextState} state
 * @param {unknown} value
 * @returns {number[]} MAX_CELLS codes
 */
function atlasCodes(state, value) {
  const atlas = state.atlas,
    cellCount = state.cells,
    text = String(value).slice(0, cellCount);
  const pad = cellCount - text.length,
    widget = state.w;
  const lead =
    widget.align === "right"
      ? pad
      : widget.align === "center"
        ? Math.floor(pad / 2)
        : 0;
  const codes = [];
  for (let i = 0; i < MAX_CELLS; i++) {
    const j = i - lead;
    const char = j >= 0 && j < text.length ? text[j] : null;
    const k = char === null ? -1 : atlas.chars.indexOf(char);
    codes.push(
      i < cellCount && char !== null
        ? k < 0
          ? atlas.chars.indexOf(" ")
          : k
        : -1,
    );
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
   * @param {Widget} widget
   * @param {WidgetState & AtextState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    const atlas = hud._atlas(widget.font, state.ci);
    state.atlas = atlas;
    state.cells = Math.max(
      1,
      Math.min(
        MAX_CELLS,
        isNum(widget.cells)
          ? Math.floor(widget.cells)
          : Math.floor(widget.w / atlas.cellW),
      ),
    );
    client.bind(ref, "u_font", atlas.ref);
    client.uniform(ref, "u_cells", [state.cells]);
    client.uniform(ref, "u_grid", [atlas.cols, atlas.rows]);
    client.uniform(ref, "u_color", rgba(color(theme, widget.color || "fg")));
    client.uniform(ref, "u_text", atlasCodes(state, ""), { type: "vec4" });
    if (widget.w !== state.cells * atlas.cellW || widget.h !== atlas.cellH) {
      hud.log.info(
        'widget "' +
          widget.id +
          '": ' +
          state.cells +
          " cells of " +
          (widget.w / state.cells).toFixed(1) +
          "x" +
          widget.h +
          " px; the glyphs keep their shape at w " +
          state.cells * atlas.cellW +
          ", h " +
          atlas.cellH,
      );
    }
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & AtextState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    if (!force && now - state.lastPaint < (widget.rate || TEXT_MS)) return;
    const value = hud._resolve(widget.text);
    if (!force && value === state.last) return;
    state.last = value;
    state.lastPaint = now;
    state.c.uniform(state.ref, "u_text", atlasCodes(state, value), {
      type: "vec4",
    });
  },
};
