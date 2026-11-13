"use strict";
/**
 * The "rdash" widget: an effect layer.
 */
const { isNum } = require("../../engine/util");
const { packCfg } = require("../../engine/cfg");
const RDASH = require("./shader");
const { MI_PER_KM } = require("../../car/consts");

const REGAL_NEEDLE_TAU_MS = 170; // Grand National's fuel and pod needles ease toward a reading: settled in about 0.5 s
const GEAR_MS = 300; // the gear needle's move: this long a letter
const REGAL_SPEED_TAU_MS = 50; // its speed needle: about 0.15 s, so it keeps up with the digits
const GEAR_X_STEPS_PER_PX = 10; // the gear needle's x is sent in tenths of a px
/** @type {number[]} */
const SPD_VIRT = [300, 45]; // "spdVirt" default: the far pivot's height px, the half sweep deg
const SPD_MID_MPH = 55; // "spdMid" default: the speed scale's middle
const SPD_MAX_MPH = 85; // "spdMax" default: its end
const SPD_STEP_MPH = 5; // "spdStep" default: between marks, and the first mark
const SPD_AMBER_MPH = 55; // "spdAmber" default: the amber mark
const SPD_REST_DEG = 12; // "spdRest" default: the needle's rest at 0, past the scale's start
const SPD_MIN_FRAC = -0.5; // the speed needle never goes further below the scale's start than this
/** @type {number[]} */
const BAT_ICON_HIDDEN = [-99, -99]; // "batIcon" default: off the layer, so not drawn
const NEEDLE_STEPS = 500; // the needles are resent only in steps of 1/500 of their scale
const NEEDLE_SNAP = 0.001; // within this of the reading (half a step) a needle is there
const MAX_EASE_DT_MS = 500; // a longer gap between updates eases as if it were this long
const DEFAULT_RPM_MAX = 8000; // "rpmMax" default: the rpm bar's end
const LED_N = 16; // "ledN" default: the rpm bar's segments
const LED_SUBSTEPS = 16; // the bars' levels are sent in sixteenths of a segment
const COLD_REDLINE_STEP_RPM = 50; // the cold redline glides in steps of this many rpm
const LED2_N = 15; // "led2N" default: the boost bar's segments
/** @type {number[]} */
const LED2_RANGE_BAR = [0, 1.5]; // "led2Range" default
const FUEL_ROW_H_PX = 21; // "fuelRowH" default
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
  "u_gearN",
  "u_lampB",
  "u_spd",
  "u_spdVirt",
  "u_spdK",
  "u_fuelG",
  "u_podG",
  "u_podZL",
  "u_podZR",
  "u_arrow",
  "u_batIcon",
];
const PACKED = packCfg(RDASH, CFG);

/**
 * A pod's value as a fraction of its scale, bottom to top: "range" [lo, hi], each half linear around "mid" (the
 * value at the middle mark, e.g. the oil's 110 C) when set.
 * @param {{ range?: number[], mid?: number } | undefined} pod
 * @param {number} value
 * @returns {number}
 */
function podFrac(pod, value) {
  const range = (pod && pod.range) || [0, 1],
    midValue = pod && isNum(pod.mid) ? pod.mid : null;
  if (midValue !== null)
    return value <= midValue
      ? (0.5 * (value - range[0])) / (midValue - range[0])
      : 0.5 + (0.5 * (value - midValue)) / (range[1] - midValue);
  return (value - range[0]) / (range[1] - range[0]);
}
/**
 * The gear needle's x on the P R N D S row ("gearRow" [first letter's x, pitch, y]) for the lit slot (-1: none, the
 * needle stays where it was; it starts at P). On a change it eases to the new letter in GEAR_MS a letter: in and out
 * from rest, out only when it was already moving (BMW goes through N, so P to D retargets on the way), and once
 * there it stays put, so the layer's uniforms change only while it moves.
 * @param {Widget} widget
 * @param {WidgetState & RdashState} state
 * @param {number} slot
 * @param {number} now
 * @returns {number}
 */
function gearNeedleX(widget, state, slot, now) {
  const row = widget.gearRow || [0, 0, 0];
  const gn = state.gn || (state.gn = { pos: 0, from: 0, to: 0, t0: 0, dur: 0, out: false });
  const along = () => {
    if (!gn.dur) return gn.to;
    const t = Math.min(1, (now - gn.t0) / gn.dur);
    const e = gn.out ? 1 - (1 - t) * (1 - t) : t * t * (3 - 2 * t);
    if (t >= 1) gn.dur = 0;
    return gn.from + (gn.to - gn.from) * e;
  };
  if (slot >= 0 && slot !== gn.to) {
    const moving = gn.dur > 0;
    gn.from = gn.pos;
    gn.to = slot;
    gn.t0 = now;
    gn.dur = GEAR_MS * Math.abs(slot - gn.pos);
    gn.out = moving;
  }
  gn.pos = along();
  return Math.round((row[0] + row[1] * gn.pos) * GEAR_X_STEPS_PER_PX) / GEAR_X_STEPS_PER_PX;
}

/** @type {(define: string) => string} the shader with one pass's #define, packed */
const variant = (define) =>
  packCfg(RDASH.replace("#endif\nvarying", "#endif\n#define " + define + "\nvarying"), CFG);
// "needleOnly": the speed and fuel needles on their own layer, over the text
const NEEDLE = variant("NEEDLE_LAYER");
// with a backdrop (a layout's "backdrop": true): the bench's bake draws only what never changes (RDASH_BAKE); the car
// draws the baked backdrop and only what moves over it (RDASH_LIVE)
const BAKE = variant("RDASH_BAKE");
const LIVE = variant("RDASH_LIVE");

/** @typedef {import("../../engine/app").Widget} Widget */
/**
 * This type's own state on its WidgetState.
 * @typedef {object} RdashState
 * @property {{ f: number, fuel: number, pods: number[] }} [ez] the eased needles
 * @property {{ pos: number, from: number, to: number, t0: number, dur: number, out: boolean }} [gn] the gear needle's move:
 *   where it is and where it goes (in letters), when the move started and how long it takes, ms; out: eased out only
 */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the whole Grand National theme (rdash/shader.js), every box [x, y, w, h] in target px: "podL" (left pod frame, the right is its mirror), "podWin" (its gauge window), "ctr", "win1", "win2" (centre panel, its upper and lower windows), "vfdL", "vfdR", "spd" [needle pivot x, y, number row's middle y, mark row's y], "spdVirt" [height, half sweep deg] (where the numbers sit: on the rays of a far pivot that high below the number row; the needle turns to point at them) with "spdMax" (85 mph), "spdMin" (0, the mph at the scale's start), "spdMid" (55, the middle; halfway between spdMin and spdMax makes the scale linear), "spdStep" (5, between marks; the first mark), "spdAmber" (55, the amber mark) and "spdRest" (12: the needle's rest at 0, deg past the scale's start, under the row), "fuelG" [pivot x, y, the end marks' crossing of fuelLine (+-x), the lower band's height], "podG" [pivot x, y, tick r0, r1], "fuelLine" (y: where the fuel marks split, E, the pump and F sitting on it) and "fuelRowH" (the row above it: E, the pump, F and the marks' upper parts this tall, 21), "podSignals" [{ signal, range, mid? }] x 2 (mid: the value at the middle mark), "podZones" [{ low?, ok?: [lo, hi], high? }] x 2 (bands on the scale's outer edge, as deep as its short marks: up to low red on the left pod and blue on the right, ok green, from high red), "led" with "ledN" and "rpmMax" (green segments, every fourth orange; a red mark above from the Redline setting to the end, from "coldRedline" [rpm, cold C, warm C] while the oil is cold, gliding to the setting as it warms), "led2" (a yellow bar: "led2Signal" (boost) over "led2Range" ([0, 1.5]), or "led2RangeUs" with US units, in "led2N" (15) segments), "gearRow" [first letter's x, pitch, y] + "gearNeedle" [pivot x, y, tip y straight up, bottom y] (a red needle of one length behind the gear row P R N D S from a far pivot below it, pointing at the letter: S in S and M; it eases from letter to letter and stays put with no gear), "lampB" (the parking brake / Auto Hold lamp, red / green; mirrored: the green CRUISE lamp), "arrow" [x, y, size], "batIcon" [x, y]`;

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
    if (widget.needleOnly) return NEEDLE;
    const backdrop = hud.backdrop;
    return backdrop ? (backdrop.bake ? BAKE : LIVE) : PACKED;
  },
  shaders: { rdash: PACKED, rdashNeedle: NEEDLE, rdashBake: BAKE, rdashLive: LIVE },
  BAKE,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState & RdashState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref;
    const packer = hud._cfgPacker(client, ref, "rdash");
    // the baked backdrop under the live parts (engine/backdrop.js)
    const backdrop = hud.backdrop;
    if (!widget.needleOnly && backdrop && !backdrop.bake && backdrop.ref) client.bind(ref, "u_back", backdrop.ref);
    /** @type {(rect: *) => number[]} */
    const rel = (rect) =>
      Array.isArray(rect) && rect.length === 4
        ? [rect[0] - widget.x, rect[1] - widget.y, rect[2], rect[3]]
        : [0, 0, 0, 0];
    const spdBox = widget.spd || [0, 0, 0, 0],
      spdVirt = widget.spdVirt || SPD_VIRT;
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
      widget.spdMid || SPD_MID_MPH,
      widget.spdMax || SPD_MAX_MPH,
      widget.spdStep || SPD_STEP_MPH,
      widget.spdAmber || SPD_AMBER_MPH,
    ]);
    const fuelG = widget.fuelG || [0, 0, 0, 0],
      podG = widget.podG || [0, 0, 0, 0],
      arrow = widget.arrow || [0, 0, 0],
      batIcon = widget.batIcon || BAT_ICON_HIDDEN;
    packer.uniform("u_fuelG", [
      fuelG[0] - widget.x,
      fuelG[1] - widget.y,
      fuelG[2],
      fuelG[3],
    ]);
    // the pods' coloured zones ("podZones" [{ low, ok: [lo, hi], high }] in each pod's own unit) as scale fractions:
    // up to low, ok lo..hi, from high (absent: none)
    [0, 1].forEach((i) => {
      const pod = (widget.podSignals || [])[i],
        zone = (widget.podZones || [])[i] || {},
        frac = (/** @type {*} */ value, /** @type {number} */ none) =>
          isNum(value) ? podFrac(pod, value) : none;
      const ok = zone.ok || [];
      packer.uniform(i === 0 ? "u_podZL" : "u_podZR", [
        frac(zone.low, -1),
        frac(ok[0], 2),
        frac(ok[1], -1),
        frac(zone.high, 2),
      ]);
    });
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
    const gearN = widget.gearNeedle || [0, 0, -1, -1];
    packer.uniform("u_gearN", [
      gearN[0] - widget.x,
      gearN[1] - widget.y,
      gearN[2] - widget.y,
      gearN[3] - widget.y,
    ]);
    if (widget.needleOnly)
      packer.uniform("u_speedV", [0]); // the needles' own layer: only the speed and the fuel change
    else {
      packer.uniform("u_gearV", [0, -1]);
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
      Math.round(Math.min(1, Math.max(0, value)) * NEEDLE_STEPS) / NEEDLE_STEPS;
    const speed = hud._raw("speed"),
      rpm = hud._raw("rpm"),
      fuel = hud._raw("fuel"),
      max = widget.rpmMax || DEFAULT_RPM_MAX;
    // the pods' gauges: each "podSignals" entry's signal over its range, bottom to top
    const pods = [0, 1].map((i) => {
      const pod = (widget.podSignals || [])[i],
        value = pod && pod.signal ? hud._raw(pod.signal) : null;
      if (!isNum(value)) return 0; // no reading (the car off): the needle sweeps down to the bottom
      return quantize(podFrac(pod, value));
    });
    const ledN = widget.ledN || LED_N;
    // the bars' levels 0..1, in sixteenths of a segment: the segment the level is partway into lights partway (the
    // shader fades it), so the bar moves smoothly instead of a whole segment at a time
    /** @type {(frac: number, n: number) => number} */
    const ledLevel = (frac, n) =>
      Math.round(Math.min(1, Math.max(0, frac)) * n * LED_SUBSTEPS) /
      (n * LED_SUBSTEPS);
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
        Math.round(
          (coldRedline[0] + (redline - coldRedline[0]) * warm) /
            COLD_REDLINE_STEP_RPM,
        ) * COLD_REDLINE_STEP_RPM;
    }
    const redAt = Math.min(1, Math.max(0, redRpm / max));
    // the boost bar: "led2Signal" over "led2Range" [lo, hi] in "led2N" segments
    const led2N = widget.led2N || LED2_N,
      // "led2RangeUs": the range with US units (Grand National's 0 .. 20 psi, in bar)
      led2Range = (hud.setting("units") === "us" && widget.led2RangeUs) ||
        widget.led2Range || LED2_RANGE_BAR,
      boost = hud._raw(widget.led2Signal || "boost");
    const led2 = isNum(boost)
      ? ledLevel((boost - led2Range[0]) / (led2Range[1] - led2Range[0]), led2N)
      : 0;
    const gearX = gearNeedleX(widget, state, hud._regalGear(), now);
    const brakeLamp = hud._brakeLamp(),
      lamps = [
        brakeLamp === "park" ? 1 : brakeLamp === "hold" ? 2 : 0,
        hud._turnLit("L") ? 1 : 0,
        hud._turnLit("R") ? 1 : 0,
        hud._cruiseLit() ? 1 : 0,
      ];
    // speed on the spdMin..spdMax mph scale with spdMid at its middle, each half linear
    const lo = widget.spdMin || 0,
      mid = widget.spdMid || SPD_MID_MPH,
      top = widget.spdMax || SPD_MAX_MPH,
      mph = isNum(speed) ? Math.max(0, speed * MI_PER_KM) : 0;
    // below the first mark ("spdStep", 5 mph) the needle drops to its rest under the row ("spdRest" deg past the 0, 12)
    const spdStep = widget.spdStep || SPD_STEP_MPH,
      half = (widget.spdVirt || SPD_VIRT)[1],
      rest = -(isNum(widget.spdRest) ? widget.spdRest : SPD_REST_DEG) / (2 * half);
    const stepFrac = (0.5 * (spdStep - lo)) / (mid - lo);
    let needleFrac =
      mph <= mid
        ? (0.5 * (mph - lo)) / (mid - lo)
        : 0.5 + (0.5 * (mph - mid)) / (top - mid);
    if (mph < spdStep) needleFrac = rest + ((stepFrac - rest) * mph) / spdStep;
    // the needles ease toward their readings (as Miku's lean: 1 - exp(-dt / tau), the same at any tick rate), so
    // they sweep instead of jumping, down to their rest when a reading goes (the car off) and up from it at the start
    const dt = state.at ? Math.min(MAX_EASE_DT_MS, now - state.at) : 0;
    state.at = now;
    /** @type {(prev: ?number, target: number, tau: number) => number} */
    const ease = (prev, target, tau) =>
      isNum(prev) ? prev + (target - prev) * (1 - Math.exp(-dt / tau)) : target;
    const fTo = Math.min(1, Math.max(SPD_MIN_FRAC, needleFrac)),
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
      Math.abs(eased - target) < NEEDLE_SNAP ? target : eased;
    state.ez.f = snap(state.ez.f, fTo);
    state.ez.fuel = snap(state.ez.fuel, fuelTo);
    state.ez.pods = state.ez.pods.map((eased, i) => snap(eased, pods[i]));
    pods.splice(0, 2, quantize(state.ez.pods[0]), quantize(state.ez.pods[1]));
    const vals = [Math.round(state.ez.f * NEEDLE_STEPS) / NEEDLE_STEPS, quantize(state.ez.fuel)];
    if (widget.needleOnly) {
      // the needles' own layer (over the text): only the speed and the fuel
      const needles = vals[0] + "|" + vals[1];
      if (!force && needles === state.last) return;
      state.last = needles;
      state.c.uniform(state.ref, "u_speedV", [vals[0]]);
      state.c.uniform(state.ref, "u_fuelV", [
        vals[1],
        (widget.fuelLine || 0) - widget.y,
        widget.fuelRowH || FUEL_ROW_H_PX,
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
      gearX +
      "|" +
      lamps.join("");
    if (!force && key === state.last) return;
    state.last = key;
    state.c.uniform(state.ref, "u_speedV", [vals[0]]);
    state.c.uniform(state.ref, "u_fuelV", [
      vals[1],
      (widget.fuelLine || 0) - widget.y,
      widget.fuelRowH || FUEL_ROW_H_PX,
    ]);
    state.c.uniform(state.ref, "u_podV", pods);
    state.c.uniform(state.ref, "u_ledV", [ledN, led, redAt]);
    state.c.uniform(state.ref, "u_led2V", [led2N, led2]);
    const gearN = widget.gearNeedle || [0, 0],
      gearRow = widget.gearRow || [0, 0, 0];
    state.c.uniform(state.ref, "u_gearV", [
      gearX - gearN[0],
      Math.min(-1, gearRow[2] - gearN[1]),
    ]);
    state.c.uniform(state.ref, "u_lamps", lamps);
  },
};
