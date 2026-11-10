"use strict";
/**
 * The "icon" widget: an image layer (pixels).
 */
const { color } = require("../../hud_themes");
const { paintIcon } = require("./icons");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `image layer; a line icon from icons.js (next to this file) ("icon": gauge, shock, wheel, cog, stack, therm, oilcan, fuel)`;

module.exports = {
  type: "icon",
  fields: ["icon"],
  docs: DOCS,
  image: true,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const theme = hud.theme;
    hud._blit(
      state,
      null,
      paintIcon(
        widget.icon,
        widget.w,
        widget.h,
        color(theme, widget.color || "fg"),
      ),
    );
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {},
};
