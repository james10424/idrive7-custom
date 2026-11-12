"use strict";
/**
 * The "boxes" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgba } = require("../../engine/util");
const BOXES = require("./shader");

const MAX_BOXES = 12; // the shader's box slots (its vec4 arrays are this long)
const BOX_BORDER_PX = 2; // default frame width

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
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    // the box list goes up as two vec4 arrays (x, y, w, h and headH, border, radius, headKind), 12 slots
    const list = (Array.isArray(widget.boxes) ? widget.boxes : [])
      .filter(
        (box) =>
          box &&
          isNum(box.x) &&
          isNum(box.y) &&
          isNum(box.w) &&
          isNum(box.h) &&
          !(box.toggle && !hud._toggleOn(box.toggle)),
      )
      .slice(0, MAX_BOXES);
    const rects = [],
      styles = [];
    for (let i = 0; i < MAX_BOXES; i++) {
      const box = list[i];
      rects.push(
        box ? box.x - widget.x : 0,
        box ? box.y - widget.y : 0,
        box ? box.w : 0,
        box ? box.h : 0,
      );
      styles.push(
        box ? box.head || 0 : 0,
        box ? (box.border === undefined ? BOX_BORDER_PX : box.border) : 0,
        box ? box.radius || 0 : 0,
        box && box.headColor === "accent" ? 1 : 0,
      );
    }
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_bg", rgba(color(theme, widget.color || "bg")));
    client.uniform(ref, "u_hole", hud._hole(widget));
    client.uniform(ref, "u_holeR", [hud._holeRadius(widget)]);
    client.uniform(ref, "u_n", [list.length]);
    client.uniform(ref, "u_box", rects, { type: "vec4" });
    client.uniform(ref, "u_boxStyle", styles, { type: "vec4" });
    client.uniform(ref, "u_fill", rgba(color(theme, widget.fill || "panel")));
    client.uniform(ref, "u_line", rgba(color(theme, widget.line || "line")));
    client.uniform(ref, "u_head", rgba(color(theme, widget.head || "head")));
    client.uniform(
      ref,
      "u_accent",
      rgba(color(theme, widget.accent || "accent")),
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
