"use strict";
/**
 * The "lights" widget: an effect layer.
 */
const { LIGHTS } = require("../../hud_themes");
const { isNum, rgb } = require("../../engine/util");
const SHADER = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; lights/shader.js, shift lights filling from "from" rpm (3000) up to the shift point. "count" (12), "from" rpm (3000) where the first light comes on, "tail" (0): the last "tail" lights are blue (the GT3 look); "round": true for dots; "off" the alpha of an unlit light (0.14).`;

module.exports = {
  type: "lights",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return SHADER;
  },
  shaders: { lights: SHADER },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref;
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_n", [widget.count || 12]);
    client.uniform(ref, "u_tail", [widget.tail || 0]);
    client.uniform(ref, "u_round", [widget.round ? 1 : 0]);
    client.uniform(ref, "u_green", rgb(LIGHTS.green));
    client.uniform(ref, "u_yellow", rgb(LIGHTS.yellow));
    client.uniform(ref, "u_red", rgb(LIGHTS.red));
    client.uniform(ref, "u_blue", rgb(LIGHTS.blue));
    client.uniform(ref, "u_off", [
      widget.off === undefined ? 0.14 : widget.off,
    ]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    const rpm = hud._raw("rpm"),
      shift = hud._shift(),
      count = widget.count || 12;
    // the lights fill from "from" rpm (3000) up to the shift point; a "from" at or past it means the last 500 rpm
    const from = Math.min(
      isNum(widget.from) ? widget.from : 3000,
      shift.rpm - 500,
    );
    const lit = isNum(rpm)
      ? Math.floor(
          Math.min(1, Math.max(0, (rpm - from) / (shift.rpm - from))) * count,
        )
      : 0;
    const key = lit + "|" + shift.now;
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_lit", [lit]);
    state.c.uniform(state.ref, "u_strobe", [shift.now ? 1 : 0]);
  },
};
