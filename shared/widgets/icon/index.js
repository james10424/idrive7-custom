"use strict";
/**
 * The "icon" widget: an image layer (pixels).
 */
const { color } = require("../../hud_themes");
const { paintIcon } = require("./icons");
const { TEXT_MS } = require("../../engine/util");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `image layer; a line icon from icons.js (next to this file) ("icon": gauge, shock, wheel, cog, stack, therm, oilcan, fuel, tyre, battery); "iconWhen" [token, icon]: that icon instead while the token has a value (not "--")`;

/**
 * The icon to show now: "iconWhen" [token, icon] while that token has a value, else "icon".
 * @param {HudApp} hud
 * @param {Widget} widget
 * @returns {string}
 */
function iconNow(hud, widget) {
  const when = widget.iconWhen;
  return Array.isArray(when) && hud._token(when[0]) !== "--" ? when[1] : widget.icon;
}

/**
 * @param {HudApp} hud
 * @param {WidgetState} state
 * @param {string} icon
 * @returns {void}
 */
function paint(hud, state, icon) {
  const widget = state.w;
  state.last = icon;
  hud._blit(state, null, paintIcon(icon, widget.w, widget.h, color(hud.theme, widget.color || "fg")));
}

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
    paint(hud, state, iconNow(hud, widget));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    if (!widget.iconWhen) return;
    if (!force && now - (state.lastCheck || 0) < TEXT_MS) return;
    state.lastCheck = now;
    const icon = iconNow(hud, widget);
    if (force || icon !== state.last) paint(hud, state, icon);
  },
};
