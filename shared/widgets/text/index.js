"use strict";
/**
 * The "text" widget: an image layer (pixels).
 */
const { VERDICT, color } = require("../../hud_themes");
const textRaster = require("../../hud_text");
const { isNum, TEXT_MS } = require("../../engine/util");

/** @typedef {import("../../hud").Widget} Widget */
/** @typedef {import("../../hud").WidgetState} WidgetState */
/** @typedef {import("../../hud").HudApp} HudApp */

const DOCS = `image layer; template tokens below, a font from hud/fonts, colour role. "color2": a second role, the colour at the bottom of the box (a top-to-bottom gradient, the chrome look). "hotWhen": "now" turns it the shift red at the shift point; "coldWhen": "cold" turns it blue while the cold guard lowers the shift point. "litGear": the Regal gear row slot (P 0 R 1 N 2 D 3, number 5) turns it "litColor" (fg) while lit. "slide": { signal ("accGap" = the car ahead in m), max, yTop, yBottom }: the text's middle rides from yBottom (0) to yTop (max) inside its box, blank without a value; "hotWhen": "closing" turns it red while the car ahead closes fast. "colorBy": "verdict" colours it by the last shift's grade. "near": ["speed" | "rpm", i] turns it "nearColor" (fg) while scale label i is the one nearest the value (BMW lights up the label by the needle); with "nearFade": n it fades instead, from its own colour n label steps away to "nearColor" at the label (iDrive 8). "font": "@sys" draws in the car's own font (any script, sysfont.js), "size" px. "needs": "<token>" draws nothing while that token is "--". Updates send only the one rectangle around the pixels that changed since the last paint.`;

module.exports = {
  type: "text",
  fields: ["text", "font"],
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
    if (!force && now - x.lastPaint < (w.rate || TEXT_MS)) return;
    const s =
      w.needs && hud._token(w.needs) === "--" ? "" : hud._resolve(w.text);
    let role = w.color || "fg";
    if (w.colorBy === "verdict" && hud.score.last)
      role = VERDICT[hud.score.last.verdict] || role;
    if (w.near && isNum(w.nearFade)) {
      // fade in as the value comes near (iDrive 8): full "nearColor" at the label, its own colour "nearFade"
      // label steps away, in 8 steps so a label repaints only when its step changes
      const pos = hud._nearPos(w.near[0]);
      const f = isNum(pos)
        ? Math.round(
            Math.max(0, 1 - Math.abs(pos - w.near[1]) / w.nearFade) * 8,
          ) / 8
        : 0;
      if (f > 0) {
        const a = color(hud.theme, role),
          b = color(hud.theme, w.nearColor || "fg");
        role = [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * f));
      }
    } else if (w.near && hud._nearMark(w.near[0]) === w.near[1])
      role = w.nearColor || "fg";
    // "litGear": the Regal gear row's slot (P 0, R 1, N 2, D 3, the gear number 5): while the lit gear box sits
    // behind it, the text turns "litColor" (fg: white on the box is 5.0:1, WCAG AA; the VFD orange was 1.9:1)
    if (isNum(w.litGear) && hud._regalGear() === w.litGear)
      role = w.litColor || "fg";
    if (w.hotWhen === "closing") {
      if (hud._closing()) role = "hot";
    } else if (w.hotWhen || w.coldWhen) {
      const sp = hud._shift();
      if (w.coldWhen && sp[w.coldWhen]) role = VERDICT.COLD;
      if (w.hotWhen && sp[w.hotWhen]) role = "hot";
    }
    // "slide": the text rides up its box with a value (the car-ahead gauge's label), blank without one
    let offY = 0,
      text = s;
    if (w.slide) {
      const v =
        w.slide.signal === "accGap"
          ? hud._acc("gap")
          : hud._raw(w.slide.signal);
      if (!isNum(v)) text = "";
      else {
        const lo = w.slide.min || 0,
          f = Math.min(1, Math.max(0, (v - lo) / ((w.slide.max || 150) - lo)));
        const y = w.slide.yBottom - f * (w.slide.yBottom - w.slide.yTop);
        offY = Math.round(
          y - w.y - textRaster.loadFont(w.font).metrics.cellHeight / 2,
        );
      }
    }
    const key = text + "|" + role + "|" + offY;
    if (!force && key === x.last) return;
    x.last = key;
    x.lastPaint = now;
    let buf;
    if (w.font === "@sys") {
      // the car's own font, any script ("size" px, default 80 % of the box)
      const f = hud._sysFont();
      const m =
        f && text
          ? f.mask(w.w, w.h, text, {
              size: w.size || Math.round(w.h * 0.8),
              align: w.align,
            })
          : Buffer.alloc(w.w * w.h);
      buf = textRaster.tint(m, w.w, w.h, { color: color(hud.theme, role) });
    } else
      buf = textRaster.drawText(w.w, w.h, text, {
        font: w.font,
        color: color(hud.theme, role),
        align: w.align,
        spacing: w.spacing,
        offsetY: offY,
        color2: w.color2 && role !== "hot" ? color(hud.theme, w.color2) : null,
        glow: w.glow ? hud.theme.glow : 0,
      });
    hud._blitDiff(x, buf);
  },
};
