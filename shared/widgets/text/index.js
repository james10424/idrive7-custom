"use strict";
/**
 * The "text" widget: an image layer (pixels).
 */
const { VERDICT, color } = require("../../hud_themes");
const textRaster = require("../../hud_text");
const { isNum, TEXT_MS } = require("../../engine/util");

const NEAR_FADE_STEPS = 8; // "nearFade" repaints a label only when its fade moves an eighth
const SLIDE_MAX = 150; // "slide" default max (the car-ahead gap, m)
const SYS_FONT_FRAC = 0.8; // "@sys" default text size, of the box height

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * A text widget's own fields (see DOCS).
 * @typedef {object} TextFields
 * @property {string} [font] a hud/fonts name, or "@sys"
 * @property {string} [color] colour role
 * @property {string} [color2]
 * @property {string} [align] left | right | center
 * @property {number} [spacing]
 * @property {number} [size] "@sys" text px
 * @property {boolean} [glow]
 * @property {number} [rate] ms between text paints
 * @property {string} [needs] a token; blank while it is "--"
 * @property {string} [colorBy]
 * @property {Array<*>} [near] ["speed" | "rpm", label index]
 * @property {number} [nearFade]
 * @property {string} [nearColor]
 * @property {number} [litGear]
 * @property {string} [litColor]
 * @property {string} [hotWhen]
 * @property {string} [coldWhen]
 * @property {string} [hotColor]
 * @property {{ signal: string, min?: number, max?: number,
 *   yTop: number, yBottom: number }} [slide]
 * @property {string} [tone]
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

// tokens whose text changes only with the settings, the theme or the layout, each of which rebuilds every widget
const STATIC_TOKEN =
  /^(u:.+|spd:\d+|temp:-?\d+|boostTick:\w+|fuelFull|fuelHalf|boostHi|boostMid)$/;
// options that make a text's colour, place or blanking follow the car
const LIVE_FIELDS = [
  "near",
  "litGear",
  "hotWhen",
  "coldWhen",
  "colorBy",
  "slide",
  "needs",
  "tone",
];

/**
 * Painted once per build: only fixed text and static tokens, nothing that follows the car.
 * @param {Widget & TextFields} widget
 * @returns {boolean}
 */
function isStatic(widget) {
  if (LIVE_FIELDS.some((field) => widget[field] !== undefined)) return false;
  const tokens = String(widget.text || "").match(/{{[^}]*}}/g) || [];
  return tokens.every((token) => STATIC_TOKEN.test(token.slice(2, -2)));
}

const DOCS = `image layer; template tokens below, a font from hud/fonts, colour role. "color2": a second role, the colour at the bottom of the box (a top-to-bottom gradient, the chrome look). "hotWhen": "now" turns it the shift red at the shift point; "coldWhen": "cold" turns it blue while the cold guard lowers the shift point. "litGear": the Grand National gear row slot (P 0 R 1 N 2 D 3 S 4) turns it "litColor" (fg) while lit. "slide": { signal ("accGap" = the car ahead in m), max, yTop, yBottom }: the text's middle rides from yBottom (0) to yTop (max) inside its box, blank without a value; "hotWhen": "closing" turns it red while the car ahead closes fast. "colorBy": "verdict" colours it by the last shift's grade. "near": ["speed" | "rpm", i] turns it "nearColor" (fg) while scale label i is the one nearest the value (BMW lights up the label by the needle); with "nearFade": n it fades instead, from its own colour n label steps away to "nearColor" at the label (iDrive 8). "font": "@sys" draws in the car's own font (any script, sysfont.js), "size" px. "needs": "<token>" draws nothing while that token is "--". Updates send only the one rectangle around the pixels that changed since the last paint.`;

module.exports = {
  type: "text",
  fields: ["text", "font"],
  docs: DOCS,
  image: true,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    state.fixed = isStatic(widget);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    // fixed text: its first paint is its last until the next build; the rest is looked at most every TEXT_MS
    if (!force && state.fixed && state.last !== null) return;
    if (!force && now - (state.lastCheck || 0) < (widget.rate || TEXT_MS))
      return;
    state.lastCheck = now;
    const resolved =
      widget.needs && hud._token(widget.needs) === "--"
        ? ""
        : hud._resolve(widget.text);
    let role = widget.color || "fg";
    if (widget.colorBy === "verdict" && hud.score.last)
      role = VERDICT[hud.score.last.verdict] || role;
    if (widget.near && isNum(widget.nearFade)) {
      // fade in as the value comes near (iDrive 8): full "nearColor" at the label, its own colour "nearFade"
      // label steps away, in 8 steps so a label repaints only when its step changes
      const pos = hud._nearPos(widget.near[0]);
      const fade = isNum(pos)
        ? Math.round(
            Math.max(0, 1 - Math.abs(pos - widget.near[1]) / widget.nearFade) *
              NEAR_FADE_STEPS,
          ) / NEAR_FADE_STEPS
        : 0;
      if (fade > 0) {
        const ownColor = color(hud.theme, role),
          nearRgba = color(hud.theme, widget.nearColor || "fg");
        role = [0, 1, 2, 3].map((i) =>
          Math.round(ownColor[i] + (nearRgba[i] - ownColor[i]) * fade),
        );
      }
    } else if (widget.near && hud._nearMark(widget.near[0]) === widget.near[1])
      role = widget.nearColor || "fg";
    // "litGear": the Grand National gear row's slot (P 0, R 1, N 2, D 3, S 4): while the lit gear box sits
    // behind it, the text turns "litColor" (fg: white on the box is 5.0:1, WCAG AA; the VFD orange was 1.9:1)
    if (isNum(widget.litGear) && hud._regalGear() === widget.litGear)
      role = widget.litColor || "fg";
    if (widget.hotWhen === "closing") {
      if (hud._closing()) role = "hot";
    } else if (widget.hotWhen || widget.coldWhen) {
      const shift = hud._shift();
      if (widget.coldWhen && shift[widget.coldWhen]) role = VERDICT.COLD;
      if (widget.hotWhen && shift[widget.hotWhen]) role = "hot";
    }
    // "slide": the text rides up its box with a value (the car-ahead gauge's label), blank without one
    let offY = 0,
      text = resolved;
    if (widget.slide) {
      const value =
        widget.slide.signal === "accGap"
          ? hud._acc("gap")
          : hud._raw(widget.slide.signal);
      if (!isNum(value)) text = "";
      else {
        const low = widget.slide.min || 0,
          progress = Math.min(
            1,
            Math.max(0, (value - low) / ((widget.slide.max || SLIDE_MAX) - low)),
          );
        const y =
          widget.slide.yBottom -
          progress * (widget.slide.yBottom - widget.slide.yTop);
        offY = Math.round(
          y -
            widget.y -
            textRaster.loadFont(widget.font).metrics.cellHeight / 2,
        );
      }
    }
    const key = text + "|" + role + "|" + offY;
    if (!force && key === state.last) return;
    state.last = key;
    state.lastPaint = now;
    let buf;
    if (widget.font === "@sys") {
      // the car's own font, any script ("size" px, default 80 % of the box)
      const sysFont = hud._sysFont();
      const mask =
        sysFont && text
          ? sysFont.mask(widget.w, widget.h, text, {
              size: widget.size || Math.round(widget.h * SYS_FONT_FRAC),
              align: widget.align,
            })
          : Buffer.alloc(widget.w * widget.h);
      buf = textRaster.tint(mask, widget.w, widget.h, {
        color: color(hud.theme, role),
      });
    } else
      buf = textRaster.drawText(widget.w, widget.h, text, {
        font: widget.font,
        color: color(hud.theme, role),
        align: widget.align,
        spacing: widget.spacing,
        offsetY: offY,
        color2:
          widget.color2 && role !== "hot"
            ? color(hud.theme, widget.color2)
            : null,
        glow: widget.glow ? hud.theme.glow : 0,
      });
    hud._blitDiff(state, buf);
  },
};
