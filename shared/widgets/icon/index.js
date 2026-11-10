"use strict";
/**
 * The "icon" widget: an image layer (pixels).
 */
const { color } = require("../../hud_themes");
const { paintIcon } = require("./icons");

/** @typedef {import("../../hud").Widget} Widget */
/** @typedef {import("../../hud").WidgetState} WidgetState */
/** @typedef {import("../../hud").HudApp} HudApp */

const DOCS = `image layer; a line icon from icons.js ("icon": gauge, shock, wheel, cog, stack, therm, oilcan, fuel)`;

module.exports = {
  type: "icon",
  fields: ["icon"],
  docs: DOCS,
  image: true,
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const t = hud.theme;
    hud._blit(x, null, paintIcon(w.icon, w.w, w.h, color(t, w.color || "fg")));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {},
};
