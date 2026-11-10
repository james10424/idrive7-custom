"use strict";
/**
 * The "fill" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { rgba } = require("../../engine/util");
const FILL = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; a solid colour (role "color", default "bg") over the whole widget, with an optional see-through "hole": [x, y, w, h] in target px, cut only while the bool setting "holeWhen" is on (the cluster's map window), shrunk by "holeInset" px on every side (6) with "holeRadius" px corners (28), so BMW's own cluster doesn't peek out at the window's corners. Opaque fill hides BMW's gauges under it.`;

module.exports = {
  type: "fill",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return FILL;
  },
  shaders: { fill: FILL },
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
    client.uniform(ref, "u_color", rgba(color(theme, widget.color || "bg")));
    client.uniform(ref, "u_hole", hud._hole(widget));
    client.uniform(ref, "u_holeR", [hud._holeRadius(widget)]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {},
};
