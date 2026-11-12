"use strict";
/**
 * The "box" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { rgba } = require("../../engine/util");
const BOX = require("./shader");

const BOX_BORDER_PX = 2; // default frame width

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; a framed box: "fill" and "line" roles, "border" px, "radius" px, and a header strip "head" px tall in role "headColor" (its label is a text widget on top)`;

module.exports = {
  type: "box",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return BOX;
  },
  shaders: { box: BOX },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_fill", rgba(color(theme, widget.fill || "panel")));
    client.uniform(ref, "u_line", rgba(color(theme, widget.line || "line")));
    client.uniform(
      ref,
      "u_head",
      rgba(color(theme, widget.headColor || "head")),
    );
    client.uniform(ref, "u_headH", [widget.head || 0]);
    client.uniform(ref, "u_border", [
      widget.border === undefined ? BOX_BORDER_PX : widget.border,
    ]);
    client.uniform(ref, "u_radius", [widget.radius || 0]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {},
};
