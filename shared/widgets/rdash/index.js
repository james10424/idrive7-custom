"use strict";
/**
 * The "rdash" widget: an effect layer.
 */
const { isNum } = require("../../engine/util");
const { packCfg } = require("../../engine/cfg");
const RDASH = require("./shader");

const REGAL_NEEDLE_TAU_MS = 170; // Regal's fuel and pod needles ease toward a reading: settled in about 0.5 s
const REGAL_SPEED_TAU_MS = 50; // its speed needle: about 0.15 s, so it keeps up with the digits
// the set-once uniforms packed into u_cfg (engine/cfg.js), in slot order
const CFG = [
  "u_podL",
  "u_podWin",
  "u_ctr",
  "u_win1",
  "u_win2",
  "u_vfdL",
  "u_vfdR",
  "u_led",
  "u_led2",
  "u_gearBox",
  "u_lampB",
  "u_spd",
  "u_spdVirt",
  "u_spdK",
  "u_fuelG",
  "u_podG",
  "u_arrow",
  "u_batIcon",
];
const PACKED = packCfg(RDASH, CFG);
// "needleOnly": the speed and fuel needles on their own layer, over the text
const NEEDLE = packCfg(
  RDASH.replace("#endif\nvarying", "#endif\n#define NEEDLE_LAYER\nvarying"),
  CFG,
);

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} RdashState
 * @property {{ f: number, fuel: number, pods: number[] }} [ez] the eased needles
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the whole Regal theme (rdash/shader.js), every box [x, y, w, h] in target px: "podL" (left pod frame, the right is its mirror), "podWin" (its gauge window), "ctr", "win1", "win2" (centre panel, its upper and lower windows), "vfdL", "vfdR", "spd" [needle pivot x, y, number row's middle y, mark row's y], "spdVirt" [height, half sweep deg] (where the numbers sit: on the rays of a far pivot that high below the number row; the needle turns to point at them) with "spdMax" (85 mph), "spdMin" (0, the mph at the scale's start), "spdMid" (55, the middle; halfway between spdMin and spdMax makes the scale linear), "spdStep" (5, between marks; the first mark), "spdAmber" (55, the amber mark) and "spdRest" (12: the needle's rest at 0, deg past the scale's start, under the row), "fuelG" [pivot x, y, the end marks' crossing of fuelLine (+-x), the lower band's height], "podG" [pivot x, y, tick r0, r1], "fuelLine" (y: where the fuel marks split, E, the pump and F sitting on it) and "fuelRowH" (the row above it: E, the pump, F and the marks' upper parts this tall, 21), "podSignals" [{ signal, range, mid? }] x 2 (mid: the value at the middle mark), "led" with "ledN" and "rpmMax" (green segments, every fourth orange; a red mark above from the Redline setting to the end, from "coldRedline" [rpm, cold C, warm C] while the oil is cold, gliding to the setting as it warms), "led2" (a yellow bar: "led2Signal" (boost) over "led2Range" ([0, 1.5]), or "led2RangeUs" with US units, in "led2N" (15) segments), "gearBox" + "gearPitch" (the lit box in the gear row P R N D _ n: D in D and S, the number in M), "lampB" (the parking brake / Auto Hold lamp, red / green; mirrored: the green CRUISE lamp), "arrow" [x, y, size], "batIcon" [x, y]`;

module.exports = {
  type: "rdash",
  fields: ["spd", "podL", "ctr"],
  docs: DOCS,
  cfg: CFG,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @returns {string}
   */
  shader(hud, widget) {
    return widget.needleOnly ? NEEDLE : PACKED;
  },
  shaders: { rdash: PACKED, rdashNeedle: NEEDLE },
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & RdashState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref;
    const packer = hud._cfgPacker(client, ref, "rdash");
    /** @type {(rect: *) => number[]} */
    const rel = (rect) =>
      Array.isArray(rect) && rect.length === 4
        ? [rect[0] - widget.x, rect[1] - widget.y, rect[2], rect[3]]
        : [0, 0, 0, 0];
    const spdBox = widget.spd || [0, 0, 0, 0],
      spdVirt = widget.spdVirt || [300, 45];
    packer.uniform("u_size", [widget.w, widget.h]);
    [
      "podL",
      "podWin",
      "ctr",
      "win1",
      "win2",
      "vfdL",
      "vfdR",
      "led",
      "led2",
      "gearBox",
      "lampB",
    ].forEach((k) => {
      packer.uniform("u_" + k, rel(widget[k]));
    });
    packer.uniform("u_spd", [
      spdBox[0] - widget.x,
      spdBox[1] - widget.y,
      spdBox[2] - widget.y,
      spdBox[3] - widget.y,
    ]);
    packer.uniform("u_spdVirt", [
      spdVirt[0],
      (spdVirt[1] * Math.PI) / 180,
      widget.spdMin || 0,
    ]);
    packer.uniform("u_spdK", [
      widget.spdMid || 55,
      widget.spdMax || 85,
      widget.spdStep || 5,
      widget.spdAmber || 55,
    ]);
    const fuelG = widget.fuelG || [0, 0, 0, 0],
      podG = widget.podG || [0, 0, 0, 0],
      arrow = widget.arrow || [0, 0, 0],
      batIcon = widget.batIcon || [-99, -99];
    packer.uniform("u_fuelG", [
      fuelG[0] - widget.x,
      fuelG[1] - widget.y,
      fuelG[2],
      fuelG[3],
    ]);
    packer.uniform("u_podG", [
      podG[0] - widget.x,
      podG[1] - widget.y,
      podG[2],
      podG[3],
    ]);
    packer.uniform("u_arrow", [
      arrow[0] - widget.x,
      arrow[1] - widget.y,
      arrow[2],
    ]);
    packer.uniform("u_batIcon", [batIcon[0] - widget.x, batIcon[1] - widget.y]);
    if (widget.needleOnly)
      packer.uniform("u_speedV", [0]); // the needles' own layer: only the speed and the fuel change
    else {
      packer.uniform("u_gearV", [widget.gearPitch || 0, -1]);
      packer.uniform("u_lamps", [0, 0, 0, 0]);
    }
    packer.flush();
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & RdashState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    /** @type {(value: number) => number} */
    const quantize = (value) =>
      Math.round(Math.min(1, Math.max(0, value)) * 500) / 500;
    const speed = hud._raw("speed"),
      rpm = hud._raw("rpm"),
      fuel = hud._raw("fuel"),
      max = widget.rpmMax || 8000;
    // the pods' gauges: each "podSignals" entry's signal over its range, bottom to top
    const pods = [0, 1].map((i) => {
      const pod = (widget.podSignals || [])[i],
        value = pod && pod.signal ? hud._raw(pod.signal) : null,
        range = (pod && pod.range) || [0, 1];
      if (!isNum(value)) return 0; // no reading (the car off): the needle sweeps down to the bottom
      // "mid": the value at the scale's middle mark (each half linear), e.g. the coolant's 110 C
      const midValue = pod && isNum(pod.mid) ? pod.mid : null;
      if (midValue !== null)
        return quantize(
          value <= midValue
            ? (0.5 * (value - range[0])) / (midValue - range[0])
            : 0.5 + (0.5 * (value - midValue)) / (range[1] - midValue),
        );
      return quantize((value - range[0]) / (range[1] - range[0]));
    });
    const ledN = widget.ledN || 16;
    // the bars' levels 0..1, in sixteenths of a segment: the segment the level is partway into lights partway (the
    // shader fades it), so the bar moves smoothly instead of a whole segment at a time
    /** @type {(frac: number, n: number) => number} */
    const ledLevel = (frac, n) =>
      Math.round(Math.min(1, Math.max(0, frac)) * n * 16) / (n * 16);
    const led = isNum(rpm) ? ledLevel(Math.max(0, rpm) / max, ledN) : 0;
    // the red mark above the labels: from the Redline setting to the scale's end; with "coldRedline" [rpm, cold C,
    // warm C] it starts at that rpm while the oil is cold and glides to the setting as the oil warms (in 50 rpm steps,
    // so it moves only as the oil does); without an oil reading, the setting
    const redline = hud.setting("redline"),
      coldRedline = widget.coldRedline,
      oil = hud._raw("oil");
    let redRpm = redline;
    if (coldRedline && isNum(oil)) {
      const warm = Math.min(
        1,
        Math.max(0, (oil - coldRedline[1]) / (coldRedline[2] - coldRedline[1])),
      );
      redRpm =
        Math.round((coldRedline[0] + (redline - coldRedline[0]) * warm) / 50) *
        50;
    }
    const redAt = Math.min(1, Math.max(0, redRpm / max));
    // the boost bar: "led2Signal" over "led2Range" [lo, hi] in "led2N" segments
    const led2N = widget.led2N || 15,
      // "led2RangeUs": the range with US units (Regal's 0 .. 20 psi, in bar)
      led2Range = (hud.setting("units") === "us" && widget.led2RangeUs) ||
        widget.led2Range || [0, 1.5],
      boost = hud._raw(widget.led2Signal || "boost");
    const led2 = isNum(boost)
      ? ledLevel((boost - led2Range[0]) / (led2Range[1] - led2Range[0]), led2N)
      : 0;
    const gear = hud._regalGear();
    const brakeLamp = hud._brakeLamp(),
      lamps = [
        brakeLamp === "park" ? 1 : brakeLamp === "hold" ? 2 : 0,
        hud._turnLit("L") ? 1 : 0,
        hud._turnLit("R") ? 1 : 0,
        hud._cruiseLit() ? 1 : 0,
      ];
    // speed on the spdMin..spdMax mph scale with spdMid at its middle, each half linear
    const lo = widget.spdMin || 0,
      mid = widget.spdMid || 55,
      top = widget.spdMax || 85,
      mph = isNum(speed) ? Math.max(0, speed * 0.621371) : 0;
    // below the first mark ("spdStep", 5 mph) the needle drops to its rest under the row ("spdRest" deg past the 0, 12)
    const spdStep = widget.spdStep || 5,
      half = (widget.spdVirt || [300, 45])[1],
      rest = -(isNum(widget.spdRest) ? widget.spdRest : 12) / (2 * half);
    const stepFrac = (0.5 * (spdStep - lo)) / (mid - lo);
    let needleFrac =
      mph <= mid
        ? (0.5 * (mph - lo)) / (mid - lo)
        : 0.5 + (0.5 * (mph - mid)) / (top - mid);
    if (mph < spdStep) needleFrac = rest + ((stepFrac - rest) * mph) / spdStep;
    // the needles ease toward their readings (as Miku's lean: 1 - exp(-dt / tau), the same at any tick rate), so
    // they sweep instead of jumping, down to their rest when a reading goes (the car off) and up from it at the start
    const dt = state.at ? Math.min(500, now - state.at) : 0;
    state.at = now;
    /** @type {(prev: ?number, target: number, tau: number) => number} */
    const ease = (prev, target, tau) =>
      isNum(prev) ? prev + (target - prev) * (1 - Math.exp(-dt / tau)) : target;
    const fTo = Math.min(1, Math.max(-0.5, needleFrac)),
      fuelTo = Math.min(1, Math.max(0, isNum(fuel) ? fuel : 0));
    if (!state.ez) state.ez = { f: rest, fuel: 0, pods: [0, 0] }; // from rest, as a gauge powering up
    state.ez.f = ease(state.ez.f, fTo, REGAL_SPEED_TAU_MS);
    state.ez.fuel = ease(state.ez.fuel, fuelTo, REGAL_NEEDLE_TAU_MS);
    state.ez.pods = pods.map((reading, i) =>
      ease(state.ez.pods[i], reading, REGAL_NEEDLE_TAU_MS),
    );
    // within half a step of the reading: there (so the messages stop once a needle settles)
    /** @type {(eased: number, target: number) => number} */
    const snap = (eased, target) =>
      Math.abs(eased - target) < 0.001 ? target : eased;
    state.ez.f = snap(state.ez.f, fTo);
    state.ez.fuel = snap(state.ez.fuel, fuelTo);
    state.ez.pods = state.ez.pods.map((eased, i) => snap(eased, pods[i]));
    pods.splice(0, 2, quantize(state.ez.pods[0]), quantize(state.ez.pods[1]));
    const vals = [Math.round(state.ez.f * 500) / 500, quantize(state.ez.fuel)];
    if (widget.needleOnly) {
      // the needles' own layer (over the text): only the speed and the fuel
      const needles = vals[0] + "|" + vals[1];
      if (!force && needles === state.last) return;
      state.last = needles;
      state.c.uniform(state.ref, "u_speedV", [vals[0]]);
      state.c.uniform(state.ref, "u_fuelV", [
        vals[1],
        (widget.fuelLine || 0) - widget.y,
        widget.fuelRowH || 21,
      ]);
      return;
    }
    const key =
      vals.join("|") +
      "|" +
      pods.join("|") +
      "|" +
      led +
      "|" +
      redAt +
      "|" +
      led2 +
      "|" +
      gear +
      "|" +
      lamps.join("");
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_speedV", [vals[0]]);
    state.c.uniform(state.ref, "u_fuelV", [
      vals[1],
      (widget.fuelLine || 0) - widget.y,
      widget.fuelRowH || 21,
    ]);
    state.c.uniform(state.ref, "u_podV", pods);
    state.c.uniform(state.ref, "u_ledV", [ledN, led, redAt]);
    state.c.uniform(state.ref, "u_led2V", [led2N, led2]);
    state.c.uniform(state.ref, "u_gearV", [widget.gearPitch || 0, gear]);
    state.c.uniform(state.ref, "u_lamps", lamps);
  },
};
