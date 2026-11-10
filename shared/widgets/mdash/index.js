"use strict";
/**
 * The "mdash" widget: an effect layer.
 */
const { isNum, rgb } = require("../../engine/util");
const MDASH = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} MdashState
 * @property {Array<Array<*>>} [gauges] [uniform, gauge]
 * @property {Array<Record<string, *>>} [bars] the segbars
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the M theme's whole backdrop (mdash/shader.js): "card" [x, yBottom, rBottom, rTop] (the left card, traced off the M8 photo: outer edge x, bottom y, the big round at the bottom outer corner, the rounding where the top curve meets the outer edge; the right card is its mirror), "cardTop" [a, b, c] (the card's top edge, y = a x^2 + b x + c), "cardCutR" [cx, cy, r] (the right card's lower outer corner cut on that circle, in the mirrored left frame), "cardFill" 0..1 (grey level, 0 = black: outline only), "blade" { xm, ym, kTop, kBot, round } (the left rev blade's outer edge, as mtach; the card ends "bladeGap" px before it), "line" [x0, y, x1, cap], "tyres" [cx, cy, scale] (the tyre block's car glyph and dividers; the eight readouts are text widgets with {{tyreP:FL}} .. {{tyreT:RR}} and {{u:pressure}}), "gaugeL" / "gaugeR" { cx, cy, r, (a dial as the M8's: a thin glass bracket whose outer edge is the circle cx, cy, r, lit from the bottom up to the value, drawn over the card; the right one is the left one's mirror) signal, min, max }, "mark" [x, y, scale], "segbars" [{ x, y, w, h, max, signal } x up to 4] (the setup level bars, "segSlant" px; the segment at round(signal) is red). Positions in target px.`;

module.exports = {
  type: "mdash",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return MDASH;
  },
  shaders: { mdash: MDASH },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & MdashState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    const tyres = widget.tyres || [0, 0, 0],
      gaugeL = widget.gaugeL || {},
      gaugeR = widget.gaugeR || {},
      blade = widget.blade || {};
    const bars = Array.isArray(widget.segbars)
      ? widget.segbars.slice(0, 4)
      : [];
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_card", widget.card || [0, 0, 0, 0]);
    client.uniform(ref, "u_cardTop", widget.cardTop || [0, 0, -99999]);
    client.uniform(ref, "u_cardCutR", widget.cardCutR || [0, 0, 0]);
    client.uniform(ref, "u_cardFill", [
      isNum(widget.cardFill) ? widget.cardFill : 0,
    ]);
    client.uniform(ref, "u_blade", [
      isNum(blade.xm) ? blade.xm - widget.x : 99999,
      (blade.ym || 0) - widget.y,
      blade.kTop || 0,
      blade.kBot || 0,
    ]);
    client.uniform(ref, "u_bladeB", [
      blade.round || 40,
      isNum(widget.bladeGap) ? widget.bladeGap : 14,
    ]);
    client.uniform(ref, "u_line", widget.line || [0, -99, 0, 1]);
    client.uniform(ref, "u_tyre", [
      tyres[0] - widget.x,
      tyres[1] - widget.y,
      tyres[2] || 0,
    ]);
    client.uniform(ref, "u_mark", widget.mark || [0, 0, 0]);
    client.uniform(ref, "u_red", rgb(theme.hot));
    [0, 1, 2, 3].forEach((i) => {
      const bar = bars[i];
      client.uniform(
        ref,
        "u_seg" + i,
        bar ? [bar.x - widget.x, bar.y - widget.y, bar.w, bar.h] : [0, 0, 0, 0],
      );
    });
    client.uniform(
      ref,
      "u_segMax",
      [0, 1, 2, 3].map((i) => (bars[i] && bars[i].max) || 1),
    );
    client.uniform(ref, "u_segSlant", [
      isNum(widget.segSlant) ? widget.segSlant : 9,
    ]);
    state.gauges = [
      ["u_gaugeL", gaugeL],
      ["u_gaugeR", gaugeR],
    ];
    state.bars = bars;
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & MdashState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const vals = state.gauges.map(([uniformName, gauge]) => {
      const value = gauge.signal ? hud._raw(gauge.signal) : null;
      return [
        uniformName,
        gauge,
        isNum(value)
          ? Math.round(
              Math.min(
                1,
                Math.max(0, (value - gauge.min) / (gauge.max - gauge.min)),
              ) * 200,
            ) / 200
          : 0,
      ];
    });
    // the setup level bars: the segment at round(signal) is lit (1-based; 0 = none)
    const lit = [0, 1, 2, 3].map((i) => {
      const bar = state.bars[i],
        value = bar && bar.signal ? hud._raw(bar.signal) : null;
      return bar && isNum(value)
        ? Math.max(0, Math.min(bar.max || 1, Math.round(value)))
        : 0;
    });
    const key = vals.map((row) => row[2]).join("|") + "|" + lit.join("|");
    if (!force && key === state.last) return;
    state.last = key;
    vals.forEach(([uniformName, gauge, level]) =>
      state.c.uniform(state.ref, uniformName, [
        gauge.cx || 0,
        gauge.cy || 0,
        gauge.r || 0,
        level,
      ]),
    );
    state.c.uniform(state.ref, "u_segLit", lit);
  },
};
