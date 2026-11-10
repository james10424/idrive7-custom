"use strict";
/**
 * The "box" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { rgba } = require("../../engine/util");
const BOX = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {InstanceType<typeof import("../../engine/app")>} HudApp */

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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_fill", rgba(color(t, w.fill || "panel")));
    c.uniform(ref, "u_line", rgba(color(t, w.line || "line")));
    c.uniform(ref, "u_head", rgba(color(t, w.headColor || "head")));
    c.uniform(ref, "u_headH", [w.head || 0]);
    c.uniform(ref, "u_border", [w.border === undefined ? 2 : w.border]);
    c.uniform(ref, "u_radius", [w.radius || 0]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {},
};
