"use strict";
/**
 * The "lights" widget: an effect layer.
 */
const { LIGHTS } = require("../../hud_themes");
const { isNum, rgb } = require("../../engine/util");
const SHADER = require("./shader");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {InstanceType<typeof import("../../engine/app")>} HudApp */

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
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref;
    c.uniform(ref, "u_size", [w.w, w.h]);
    c.uniform(ref, "u_n", [w.count || 12]);
    c.uniform(ref, "u_tail", [w.tail || 0]);
    c.uniform(ref, "u_round", [w.round ? 1 : 0]);
    c.uniform(ref, "u_green", rgb(LIGHTS.green));
    c.uniform(ref, "u_yellow", rgb(LIGHTS.yellow));
    c.uniform(ref, "u_red", rgb(LIGHTS.red));
    c.uniform(ref, "u_blue", rgb(LIGHTS.blue));
    c.uniform(ref, "u_off", [w.off === undefined ? 0.14 : w.off]);
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    const rpm = hud._raw("rpm"),
      sp = hud._shift(),
      n = w.count || 12;
    // the lights fill from "from" rpm (3000) up to the shift point; a "from" at or past it means the last 500 rpm
    const from = Math.min(isNum(w.from) ? w.from : 3000, sp.rpm - 500);
    const lit = isNum(rpm)
      ? Math.floor(Math.min(1, Math.max(0, (rpm - from) / (sp.rpm - from))) * n)
      : 0;
    const key = lit + "|" + sp.now;
    if (!force && key === x.last) return;
    x.last = key;
    x.c.uniform(x.ref, "u_lit", [lit]);
    x.c.uniform(x.ref, "u_strobe", [sp.now ? 1 : 0]);
  },
};
