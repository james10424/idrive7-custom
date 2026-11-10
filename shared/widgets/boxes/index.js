"use strict";
/**
 * The "boxes" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgba } = require("../../engine/util");
const BOXES = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the GT3 dash's frame in ONE layer (boxes/shader.js; the car draws only a few effect layers): the background (role "color", default "bg") with the optional map "hole" as fill, and up to 12 framed boxes "boxes": [{ id, x, y, w, h (target px), head (header strip px), border (2), radius (0), headColor "accent" (else the "head" role), toggle }]. Roles "fill" (panel), "line", "head", "accent" for all of them; the labels are text widgets on top. Sent as array uniforms (vec4 x 12).`;

module.exports = {
  type: "boxes",
  fields: ["boxes"],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return BOXES;
  },
  shaders: { boxes: BOXES },
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    // the box list goes up as two vec4 arrays (x, y, w, h and headH, border, radius, headKind), 12 slots
    const list = (Array.isArray(w.boxes) ? w.boxes : [])
      .filter(
        (b) =>
          b &&
          isNum(b.x) &&
          isNum(b.y) &&
          isNum(b.w) &&
          isNum(b.h) &&
          !(b.toggle && !hud._toggleOn(b.toggle)),
      )
      .slice(0, 12);
    const rects = [],
      styles = [];
    for (let i = 0; i < 12; i++) {
      const b = list[i];
      rects.push(
        b ? b.x - w.x : 0,
        b ? b.y - w.y : 0,
        b ? b.w : 0,
        b ? b.h : 0,
      );
      styles.push(
        b ? b.head || 0 : 0,
        b ? (b.border === undefined ? 2 : b.border) : 0,
        b ? b.radius || 0 : 0,
        b && b.headColor === "accent" ? 1 : 0,
      );
    }
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_bg", rgba(color(t, w.color || "bg")));
    c.uniform(ref, "u_hole", hud._hole(w));
    c.uniform(ref, "u_holeR", [hud._holeRadius(w)]);
    c.uniform(ref, "u_n", [list.length]);
    c.uniform(ref, "u_box", rects, { type: "vec4" });
    c.uniform(ref, "u_boxStyle", styles, { type: "vec4" });
    c.uniform(ref, "u_fill", rgba(color(t, w.fill || "panel")));
    c.uniform(ref, "u_line", rgba(color(t, w.line || "line")));
    c.uniform(ref, "u_head", rgba(color(t, w.head || "head")));
    c.uniform(ref, "u_accent", rgba(color(t, w.accent || "accent")));
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {},
};
