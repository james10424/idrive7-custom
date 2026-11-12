"use strict";
/**
 * The "odo" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgba } = require("../../engine/util");
const ODO = require("./shader");
const { MI_PER_KM } = require("../../car/consts");

const ODO_DRUMS = 6; // default number of drums
const ODO_MAX_DRUMS = 8; // the shader's drum slots (u_drum, two vec4)
const ODO_GAP_PX = 2; // default gap between drums
const ODO_FRAME_PX = 1; // default drum frame width
const ODO_ROLL_STEPS = 50; // a drum's turn is resent only in steps of 1/50 of a digit

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} OdoState
 * @property {import("../../engine/app").GlyphAtlas} [atlas]
 * @property {number} [drums]
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer (odo/shader.js): a mechanical odometer, "drums" (6) digit drums of "font"'s glyph atlas (r_gl), "color" role, "gap" px between drums (2), "frame" px (1); the car's KombiIF mileageKilometre in the units setting's unit, the last drum turning with the distance (from the speed between whole km) and the others rolling over as the real gears do. "source": "range" shows the range instead (the car's own km, in the units setting's unit, whole, at most all nines). Blank drums without a reading.`;

module.exports = {
  type: "odo",
  fields: [],
  docs: DOCS,
  /** @returns {string} */
  shader() {
    return ODO;
  },
  shaders: { odo: ODO },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & OdoState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    const atlas = hud._atlas(widget.font || "r_gl", state.ci);
    state.atlas = atlas;
    const dig = "0123456789"
      .split("")
      .map((char) => Math.max(0, atlas.chars.indexOf(char)))
      .concat([0, 0]);
    state.drums = Math.max(1, Math.min(ODO_MAX_DRUMS, widget.drums || ODO_DRUMS));
    client.bind(ref, "u_font", atlas.ref);
    client.uniform(ref, "u_grid", [atlas.cols, atlas.rows]);
    client.uniform(ref, "u_dig", dig, { type: "vec4" });
    client.uniform(ref, "u_color", rgba(color(theme, widget.color || "fg")));
    client.uniform(ref, "u_size", [widget.w, widget.h]);
    client.uniform(ref, "u_odo", [
      state.drums,
      isNum(widget.gap) ? widget.gap : ODO_GAP_PX,
      0,
      isNum(widget.frame) ? widget.frame : ODO_FRAME_PX,
    ]);
    client.uniform(ref, "u_drum", [0, 0, 0, 0, 0, 0, 0, 0], { type: "vec4" });
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & OdoState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    // the drums of a mechanical odometer in the units setting's unit: the last turns with the distance, each other
    // rolls over only through its lower neighbours' last unit (9 -> 0), as the gears of a real one
    const drumCount = state.drums,
      useMiles = hud.setting("units") === "us";
    // "source": "range": the range instead, whole, capped at all nines, already in the display unit
    let distanceNow = null;
    if (widget.source === "range") {
      const range = hud._raw("range");
      if (isNum(range))
        distanceNow = Math.min(
          Math.pow(10, drumCount) - 1,
          Math.max(0, Math.round(useMiles ? range * MI_PER_KM : range)),
        );
    } else {
      const km = hud._odometer(now);
      if (isNum(km)) distanceNow = useMiles ? km * MI_PER_KM : km;
    }
    const drums = [0, 0, 0, 0, 0, 0, 0, 0];
    if (isNum(distanceNow)) {
      const distance = distanceNow % Math.pow(10, drumCount);
      for (let k = 0; k < drumCount; k++) {
        const place = Math.pow(10, k),
          lower = distance % place;
        const roll = k === 0 ? distance % 1 : Math.max(0, lower - (place - 1));
        drums[drumCount - 1 - k] =
          Math.round(((Math.floor(distance / place) % 10) + roll) * ODO_ROLL_STEPS) / ODO_ROLL_STEPS;
      }
    }
    const key = isNum(distanceNow) + "|" + drums.join(",");
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_odo", [
      drumCount,
      isNum(widget.gap) ? widget.gap : ODO_GAP_PX,
      isNum(distanceNow) ? 1 : 0,
      isNum(widget.frame) ? widget.frame : ODO_FRAME_PX,
    ]);
    state.c.uniform(state.ref, "u_drum", drums, { type: "vec4" });
  },
};
