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

/** The backdrop's parts, each a #define in the shader (mdash/shader.js main). */
const PARTS = {
  cards: "MD_CARDS",
  line: "MD_LINE",
  tyre: "MD_TYRE",
  gaugeL: "MD_GAUGE_L",
  gaugeR: "MD_GAUGE_R",
  segs: "MD_SEGS",
  mark: "MD_MARK",
};

/**
 * The shader drawing these parts (all of them: the whole backdrop in one shader, 8724 tokens, which crashed the KOMBI).
 * @param {string[]} [parts]
 * @returns {string}
 */
function source(parts) {
  const names = parts && parts.length ? parts : Object.keys(PARTS);
  return (
    names
      .filter((name) => PARTS[name])
      .map((name) => "#define " + PARTS[name] + "\n")
      .join("") + MDASH
  );
}

/**
 * The whole backdrop's frame [x, y, w, h] in target px: "frame", else the widget's own rect.
 * @param {Widget} widget
 * @returns {number[]}
 */
function frameOf(widget) {
  return Array.isArray(widget.frame) && widget.frame.length === 4
    ? widget.frame
    : [widget.x, widget.y, widget.w, widget.h];
}

const DOCS = `effect layer; the M theme's whole backdrop (mdash/shader.js): "card" [x, yBottom, rBottom, rTop] (the left card, traced off the M8 photo: outer edge x, bottom y, the big round at the bottom outer corner, the rounding where the top curve meets the outer edge; the right card is its mirror), "cardTop" [a, b, c] (the card's top edge, y = a x^2 + b x + c), "cardCutR" [cx, cy, r] (the right card's lower outer corner cut on that circle, in the mirrored left frame), "cardFill" 0..1 (grey level, 0 = black: outline only), "blade" { xm, ym, kTop, kBot, round } (the left rev blade's outer edge, as mtach; the card ends "bladeGap" px before it), "line" [x0, y, x1, cap], "tyres" [cx, cy, scale] (the tyre block's car glyph and dividers; the eight readouts are text widgets with {{tyreP:FL}} .. {{tyreT:RR}} and {{u:pressure}}), "gaugeL" / "gaugeR" { cx, cy, r, (a dial as the M8's: a thin glass bracket whose outer edge is the circle cx, cy, r, lit from the bottom up to the value, drawn over the card; the right one is the left one's mirror) signal, min, max }, "mark" [x, y, scale], "segbars" [{ x, y, w, h, max, signal } x up to 4] (the setup level bars, "segSlant" px; the segment at round(signal) is red). Positions in target px. Split over layers: "parts" (any of cards, line, tyre, gaugeL, gaugeR, segs, mark; default all) picks what this layer draws, each part its shader's code, so no layer's shader is the whole one; "frame" [x, y, w, h] is the whole backdrop's rect (default this widget's), the positions' frame, and the widget's own rect is the piece it draws. A layer without "cards" is clear where it draws nothing, so it goes over the one with them.`;

module.exports = {
  type: "mdash",
  fields: [],
  docs: DOCS,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @returns {string}
   */
  shader(hud, widget) {
    return source(widget.parts);
  },
  // as the M layout splits it (apps/custom_cluster/hud/layouts/m.json): measured by tools/shader_budget.js
  shaders: {
    mdash_base: source(["cards", "line", "tyre", "segs", "mark"]),
    mdash_dials: source(["gaugeL", "gaugeR"]),
  },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & MdashState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme,
      frame = frameOf(widget),
      fx = frame[0],
      fy = frame[1];
    const tyres = widget.tyres || [0, 0, 0],
      gaugeL = widget.gaugeL || {},
      gaugeR = widget.gaugeR || {},
      blade = widget.blade || {};
    const bars = Array.isArray(widget.segbars)
      ? widget.segbars.slice(0, 4)
      : [];
    client.uniform(ref, "u_size", [frame[2], frame[3]]);
    client.uniform(ref, "u_rect", [
      widget.x - fx,
      widget.y - fy,
      widget.w,
      widget.h,
    ]);
    client.uniform(ref, "u_card", widget.card || [0, 0, 0, 0]);
    client.uniform(ref, "u_cardTop", widget.cardTop || [0, 0, -99999]);
    client.uniform(ref, "u_cardCutR", widget.cardCutR || [0, 0, 0]);
    client.uniform(ref, "u_cardFill", [
      isNum(widget.cardFill) ? widget.cardFill : 0,
    ]);
    client.uniform(ref, "u_blade", [
      isNum(blade.xm) ? blade.xm - fx : 99999,
      (blade.ym || 0) - fy,
      blade.kTop || 0,
      blade.kBot || 0,
    ]);
    client.uniform(ref, "u_bladeB", [
      blade.round || 40,
      isNum(widget.bladeGap) ? widget.bladeGap : 14,
    ]);
    client.uniform(ref, "u_line", widget.line || [0, -99, 0, 1]);
    client.uniform(ref, "u_tyre", [
      tyres[0] - fx,
      tyres[1] - fy,
      tyres[2] || 0,
    ]);
    client.uniform(ref, "u_mark", widget.mark || [0, 0, 0]);
    client.uniform(ref, "u_red", rgb(theme.hot));
    [0, 1, 2, 3].forEach((i) => {
      const bar = bars[i];
      client.uniform(
        ref,
        "u_seg" + i,
        bar ? [bar.x - fx, bar.y - fy, bar.w, bar.h] : [0, 0, 0, 0],
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
