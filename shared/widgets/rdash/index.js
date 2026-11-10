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
   * @param {Widget} w
   * @returns {string}
   */
  shader(hud, w) {
    return w.needleOnly ? NEEDLE : PACKED;
  },
  shaders: { rdash: PACKED, rdashNeedle: NEEDLE },
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState & RdashState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref;
    const pk = hud._cfgPacker(c, ref, "rdash");
    /** @type {(r: *) => number[]} */
    const o4 = (r) =>
      Array.isArray(r) && r.length === 4
        ? [r[0] - w.x, r[1] - w.y, r[2], r[3]]
        : [0, 0, 0, 0];
    const sp = w.spd || [0, 0, 0, 0],
      sv = w.spdVirt || [300, 45];
    pk.uniform("u_size", [w.w, w.h]);
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
      pk.uniform("u_" + k, o4(w[k]));
    });
    pk.uniform("u_spd", [sp[0] - w.x, sp[1] - w.y, sp[2] - w.y, sp[3] - w.y]);
    pk.uniform("u_spdVirt", [sv[0], (sv[1] * Math.PI) / 180]);
    pk.uniform("u_spdK", [w.spdMid || 55, w.spdMax || 85, w.spdStep || 5]);
    const fg = w.fuelG || [0, 0, 0, 0],
      pg = w.podG || [0, 0, 0, 0],
      ar = w.arrow || [0, 0, 0],
      bi = w.batIcon || [-99, -99];
    pk.uniform("u_fuelG", [fg[0] - w.x, fg[1] - w.y, fg[2], fg[3]]);
    pk.uniform("u_podG", [pg[0] - w.x, pg[1] - w.y, pg[2], pg[3]]);
    pk.uniform("u_arrow", [ar[0] - w.x, ar[1] - w.y, ar[2]]);
    pk.uniform("u_batIcon", [bi[0] - w.x, bi[1] - w.y]);
    if (w.needleOnly)
      pk.uniform("u_speedV", [0]); // the needle's own layer: only the speed changes
    else {
      pk.uniform("u_gearV", [w.gearPitch || 0, -1]);
      pk.uniform("u_lamps", [0, 0, 0, 0]);
    }
    pk.flush();
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState & RdashState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    /** @type {(v: number) => number} */
    const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 500) / 500;
    const sp = hud._raw("speed"),
      rpm = hud._raw("rpm"),
      fuel = hud._raw("fuel"),
      max = w.rpmMax || 8000;
    // the pods' gauges: each "podSignals" entry's signal over its range, bottom to top
    const pods = [0, 1].map((i) => {
      const g = (w.podSignals || [])[i],
        v = g && g.signal ? hud._raw(g.signal) : null,
        r = (g && g.range) || [0, 1];
      if (!isNum(v)) return 0; // no reading (the car off): the needle sweeps down to the bottom
      // "mid": the value at the scale's middle mark (each half linear), e.g. the coolant's 110 C
      const m = g && isNum(g.mid) ? g.mid : null;
      if (m !== null)
        return q(
          v <= m
            ? (0.5 * (v - r[0])) / (m - r[0])
            : 0.5 + (0.5 * (v - m)) / (r[1] - m),
        );
      return q((v - r[0]) / (r[1] - r[0]));
    });
    const n = w.ledN || 16;
    const led = isNum(rpm)
      ? Math.floor((Math.max(0, rpm) / max) * n + 0.5) / n
      : 0;
    const shiftAt = Math.floor((hud._shift().rpm / max) * n) / n;
    // the boost bar: "led2Signal" over "led2Range" [lo, hi] in "led2N" segments
    const n2 = w.led2N || 15,
      r2 = w.led2Range || [0, 1.5],
      b2 = hud._raw(w.led2Signal || "boost");
    const led2 = isNum(b2)
      ? Math.floor(
          Math.min(1, Math.max(0, (b2 - r2[0]) / (r2[1] - r2[0]))) * n2 + 0.5,
        ) / n2
      : 0;
    const gi = hud._regalGear();
    const bl = hud._brakeLamp(),
      lamps = [
        bl === "park" ? 1 : bl === "hold" ? 2 : 0,
        hud._turnLit("L") ? 1 : 0,
        hud._turnLit("R") ? 1 : 0,
        hud._cruiseLit() ? 1 : 0,
      ];
    // speed on the 0..spdMax mph scale with spdMid at its middle, each half linear
    const mid = w.spdMid || 55,
      top = w.spdMax || 85,
      mph = isNum(sp) ? Math.max(0, sp * 0.621371) : 0;
    // below the first mark ("spdStep", 5 mph) the needle drops to its rest under the row ("spdRest" deg past the 0, 12)
    const st = w.spdStep || 5,
      half = (w.spdVirt || [300, 45])[1],
      rest = -(isNum(w.spdRest) ? w.spdRest : 12) / (2 * half);
    const f5 = (0.5 * st) / mid;
    let f =
      mph <= mid ? (0.5 * mph) / mid : 0.5 + (0.5 * (mph - mid)) / (top - mid);
    if (mph < st) f = rest + ((f5 - rest) * mph) / st;
    // the needles ease toward their readings (as Miku's lean: 1 - exp(-dt / tau), the same at any tick rate), so
    // they sweep instead of jumping, down to their rest when a reading goes (the car off) and up from it at the start
    const dt = x.at ? Math.min(500, now - x.at) : 0;
    x.at = now;
    /** @type {(prev: ?number, to: number, tau: number) => number} */
    const ease = (prev, to, tau) =>
      isNum(prev) ? prev + (to - prev) * (1 - Math.exp(-dt / tau)) : to;
    const fTo = Math.min(1, Math.max(-0.5, f)),
      fuelTo = Math.min(1, Math.max(0, isNum(fuel) ? fuel : 0));
    if (!x.ez) x.ez = { f: rest, fuel: 0, pods: [0, 0] }; // from rest, as a gauge powering up
    x.ez.f = ease(x.ez.f, fTo, REGAL_SPEED_TAU_MS);
    x.ez.fuel = ease(x.ez.fuel, fuelTo, REGAL_NEEDLE_TAU_MS);
    x.ez.pods = pods.map((v, i) => ease(x.ez.pods[i], v, REGAL_NEEDLE_TAU_MS));
    // within half a step of the reading: there (so the messages stop once a needle settles)
    /** @type {(e: number, to: number) => number} */
    const snap = (e, to) => (Math.abs(e - to) < 0.001 ? to : e);
    x.ez.f = snap(x.ez.f, fTo);
    x.ez.fuel = snap(x.ez.fuel, fuelTo);
    x.ez.pods = x.ez.pods.map((e, i) => snap(e, pods[i]));
    pods.splice(0, 2, q(x.ez.pods[0]), q(x.ez.pods[1]));
    const vals = [Math.round(x.ez.f * 500) / 500, q(x.ez.fuel)];
    if (w.needleOnly) {
      // the speed needle's own layer (over the text): only its speed
      if (!force && vals[0] === x.last) return;
      x.last = vals[0];
      x.c.uniform(x.ref, "u_speedV", [vals[0]]);
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
      gi +
      "|" +
      lamps.join("");
    if (!force && key === x.last) return;
    x.last = key;
    x.c.uniform(x.ref, "u_speedV", [vals[0]]);
    x.c.uniform(x.ref, "u_fuelV", [vals[1]]);
    x.c.uniform(x.ref, "u_podV", pods);
    x.c.uniform(x.ref, "u_ledV", [n, led, shiftAt]);
    x.c.uniform(x.ref, "u_led2V", [n2, led2]);
    x.c.uniform(x.ref, "u_gearV", [w.gearPitch || 0, gi]);
    x.c.uniform(x.ref, "u_lamps", lamps);
  },
};
