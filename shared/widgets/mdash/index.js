"use strict";
/**
 * The "mdash" widget: an effect layer.
 */
const { isNum, rgb } = require("../../engine/util");
const MDASH = require("./shader");

/** @typedef {import("../../hud").Widget} Widget */
/** @typedef {import("../../hud").WidgetState} WidgetState */
/** @typedef {import("../../hud").HudApp} HudApp */

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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    const ty = w.tyres || [0, 0, 0],
      L = w.gaugeL || {},
      R = w.gaugeR || {},
      b = w.blade || {};
    const bars = Array.isArray(w.segbars) ? w.segbars.slice(0, 4) : [];
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_card", w.card || [0, 0, 0, 0]);
    c.uniform(ref, "u_cardTop", w.cardTop || [0, 0, -99999]);
    c.uniform(ref, "u_cardCutR", w.cardCutR || [0, 0, 0]);
    c.uniform(ref, "u_cardFill", [isNum(w.cardFill) ? w.cardFill : 0]);
    c.uniform(ref, "u_blade", [
      isNum(b.xm) ? b.xm - w.x : 99999,
      (b.ym || 0) - w.y,
      b.kTop || 0,
      b.kBot || 0,
    ]);
    c.uniform(ref, "u_bladeB", [
      b.round || 40,
      isNum(w.bladeGap) ? w.bladeGap : 14,
    ]);
    c.uniform(ref, "u_line", w.line || [0, -99, 0, 1]);
    c.uniform(ref, "u_tyre", [ty[0] - w.x, ty[1] - w.y, ty[2] || 0]);
    c.uniform(ref, "u_mark", w.mark || [0, 0, 0]);
    c.uniform(ref, "u_red", rgb(t.hot));
    [0, 1, 2, 3].forEach((i) => {
      const s = bars[i];
      c.uniform(
        ref,
        "u_seg" + i,
        s ? [s.x - w.x, s.y - w.y, s.w, s.h] : [0, 0, 0, 0],
      );
    });
    c.uniform(
      ref,
      "u_segMax",
      [0, 1, 2, 3].map((i) => (bars[i] && bars[i].max) || 1),
    );
    c.uniform(ref, "u_segSlant", [isNum(w.segSlant) ? w.segSlant : 9]);
    x.gauges = [
      ["u_gaugeL", L],
      ["u_gaugeR", R],
    ];
    x.bars = bars;
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const vals = x.gauges.map(([u, G]) => {
      const v = G.signal ? hud._raw(G.signal) : null;
      return [
        u,
        G,
        isNum(v)
          ? Math.round(
              Math.min(1, Math.max(0, (v - G.min) / (G.max - G.min))) * 200,
            ) / 200
          : 0,
      ];
    });
    // the setup level bars: the segment at round(signal) is lit (1-based; 0 = none)
    const lit = [0, 1, 2, 3].map((i) => {
      const s = x.bars[i],
        v = s && s.signal ? hud._raw(s.signal) : null;
      return s && isNum(v)
        ? Math.max(0, Math.min(s.max || 1, Math.round(v)))
        : 0;
    });
    const key = vals.map((v) => v[2]).join("|") + "|" + lit.join("|");
    if (!force && key === x.last) return;
    x.last = key;
    vals.forEach(([u, G, v]) =>
      x.c.uniform(x.ref, u, [G.cx || 0, G.cy || 0, G.r || 0, v]),
    );
    x.c.uniform(x.ref, "u_segLit", lit);
  },
};
