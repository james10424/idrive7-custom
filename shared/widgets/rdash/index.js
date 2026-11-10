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
// "needleOnly": the speed needle on its own layer, over the text
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

const DOCS = `effect layer; the whole Regal theme (rdash/shader.js), every box [x, y, w, h] in target px: "podL" (left pod frame, the right is its mirror), "podWin" (its gauge window), "ctr", "win1", "win2" (centre panel, its upper and lower windows), "vfdL", "vfdR", "spd" [needle pivot x, y, number row's middle y, mark row's y], "spdVirt" [height, half sweep deg] (where the numbers sit: on the rays of a far pivot that high below the number row; the needle turns to point at them) with "spdMax" (85 mph), "spdMid" (55, the middle), "spdStep" (5, between marks; the first mark) and "spdRest" (12: the needle's rest at 0, deg past the scale's start, under the row), "fuelG" / "podG" [pivot x, y, tick r0, r1], "podSignals" [{ signal, range, mid? }] x 2 (mid: the value at the middle mark), "led" with "ledN" and "rpmMax", "led2" (a yellow bar: "led2Signal" (boost) over "led2Range" ([0, 1.5]) in "led2N" (15) segments), "gearBox" + "gearPitch" (the lit box in the gear row P R N D _ n: D in D and S, the number in M), "lampB" (the parking brake / Auto Hold lamp, red / green; mirrored: the green CRUISE lamp), "arrow" [x, y, size], "batIcon" [x, y]`;

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
    packer.uniform("u_spdVirt", [spdVirt[0], (spdVirt[1] * Math.PI) / 180]);
    packer.uniform("u_spdK", [
      widget.spdMid || 55,
      widget.spdMax || 85,
      widget.spdStep || 5,
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
      packer.uniform("u_speedV", [0]); // the needle's own layer: only the speed changes
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
    const led = isNum(rpm)
      ? Math.floor((Math.max(0, rpm) / max) * ledN + 0.5) / ledN
      : 0;
    const shiftAt = Math.floor((hud._shift().rpm / max) * ledN) / ledN;
    // the boost bar: "led2Signal" over "led2Range" [lo, hi] in "led2N" segments
    const led2N = widget.led2N || 15,
      led2Range = widget.led2Range || [0, 1.5],
      boost = hud._raw(widget.led2Signal || "boost");
    const led2 = isNum(boost)
      ? Math.floor(
          Math.min(
            1,
            Math.max(0, (boost - led2Range[0]) / (led2Range[1] - led2Range[0])),
          ) *
            led2N +
            0.5,
        ) / led2N
      : 0;
    const gear = hud._regalGear();
    const brakeLamp = hud._brakeLamp(),
      lamps = [
        brakeLamp === "park" ? 1 : brakeLamp === "hold" ? 2 : 0,
        hud._turnLit("L") ? 1 : 0,
        hud._turnLit("R") ? 1 : 0,
        hud._cruiseLit() ? 1 : 0,
      ];
    // speed on the 0..spdMax mph scale with spdMid at its middle, each half linear
    const mid = widget.spdMid || 55,
      top = widget.spdMax || 85,
      mph = isNum(speed) ? Math.max(0, speed * 0.621371) : 0;
    // below the first mark ("spdStep", 5 mph) the needle drops to its rest under the row ("spdRest" deg past the 0, 12)
    const spdStep = widget.spdStep || 5,
      half = (widget.spdVirt || [300, 45])[1],
      rest = -(isNum(widget.spdRest) ? widget.spdRest : 12) / (2 * half);
    const stepFrac = (0.5 * spdStep) / mid;
    let needleFrac =
      mph <= mid ? (0.5 * mph) / mid : 0.5 + (0.5 * (mph - mid)) / (top - mid);
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
      // the speed needle's own layer (over the text): only its speed
      if (!force && vals[0] === state.last) return;
      state.last = vals[0];
      state.c.uniform(state.ref, "u_speedV", [vals[0]]);
      return;
    }
    const key =
      vals.join("|") +
      "|" +
      pods.join("|") +
      "|" +
      led +
      "|" +
      shiftAt +
      "|" +
      led2 +
      "|" +
      gear +
      "|" +
      lamps.join("");
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_speedV", [vals[0]]);
    state.c.uniform(state.ref, "u_fuelV", [vals[1]]);
    state.c.uniform(state.ref, "u_podV", pods);
    state.c.uniform(state.ref, "u_ledV", [ledN, led, shiftAt]);
    state.c.uniform(state.ref, "u_led2V", [led2N, led2]);
    state.c.uniform(state.ref, "u_gearV", [widget.gearPitch || 0, gear]);
    state.c.uniform(state.ref, "u_lamps", lamps);
  },
};
