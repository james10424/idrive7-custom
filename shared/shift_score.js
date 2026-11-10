"use strict";
/**
 * Shift scoring and the cold-engine rev guard, for the Redline HUD layout. The rules are ported
 * from cauliflowermossgrape's Redline app (apps/redline/main.js, MIT, Copyright (c) 2026
 * cauliflowermossgrape), with the petrol defaults this car needs:
 *
 *  - shift point = redline - "shiftBefore" (never below 2500 rpm)
 *  - cold guard ("coldGuard" on): until the oil reaches 80 °C the shift point is pulled down to
 *    4500 rpm at 30 °C oil and climbs with the oil temperature, in 50 rpm steps
 *  - every upshift (gear number +1; or, with no gear signal, rpm falling over 18 % within 0.4 s
 *    while moving) is scored on the highest rpm in the 0.6 s before it:
 *    LIMITER (within 60 rpm of the redline), EARLY (over 250 under the shift point),
 *    LATE (over 200 above it; COLD REV while the guard holds it down), else SPOT ON.
 *    Shifts under 2500 rpm aren't scored.
 *  - peak rpm, held 15 s; limiter hits counted per session.
 *
 *   const score = new ShiftScore(car, () => ({ redline, shiftBefore, coldGuard }), log)
 *   score.shiftPoint(oil) -> { rpm, cold }
 *   score.last -> { at, from, to, rpm, target, verdict } or null; score.peak, score.limiterHits
 */
/**
 * The kit Car's data() (kit/runtime/car.js): the common driving signals, scaled.
 * @typedef {object} CarData
 * @property {number} [rpm]
 * @property {number} [speed] km/h
 * @property {number} [gLong] longitudinal acceleration, g
 * @property {number} [gLat] lateral acceleration, g
 * @property {number} [coolant] deg C
 * @property {number} [oil] deg C
 * @property {number} [gear] engaged gear, 0 when none
 * @property {number} [torque]
 * @property {boolean} [demo] true while the demo drive stands in for the car
 * @property {string} [stage] the selector position: "P", "R", "N" or "D"
 * @property {number} [condition] BMW's vehicle state number (10 = drive-ready)
 */
/**
 * The kit's Car instance (kit/runtime/car.js), as used here.
 * @typedef {object} Car
 * @property {() => CarData} data
 * @property {(fn: (d: CarData, tMs: number) => void, reset?: () => void) => void} onSample
 * @property {(rpm: number) => void} [setRedline]
 */
/**
 * The settings the score reads, asked for on every use.
 * @typedef {object} ShiftOpts
 * @property {number} redline rpm
 * @property {number} shiftBefore rpm under the redline
 * @property {boolean} coldGuard
 */
/**
 * The last scored upshift.
 * @typedef {object} Shift
 * @property {number} at Date.now() when scored
 * @property {number|string} from gear, "?" when guessed from the rpm
 * @property {number|string} to
 * @property {number} rpm the highest rpm before the shift
 * @property {number} target the shift point then
 * @property {string} verdict "LIMITER", "EARLY", "LATE", "COLD REV" or "SPOT ON"
 */
/** @typedef {{ info: (s: string) => void, warn?: (s: string) => void, error?: (s: string) => void }} Log */

const WARM_OIL = 80; // °C
const COLD_LIMIT = 4500; // rpm at 30 °C oil (Redline's petrol default)
const PEAK_HOLD_MS = 15000;
/** @type {(v: any) => v is number} */
const isNum = (v) => typeof v === "number" && isFinite(v);
/** @type {(v: number, a: number, b: number) => number} */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

class ShiftScore {
  /**
   * @param {Car} car
   * @param {() => ShiftOpts} opts
   * @param {Log} log
   */
  constructor(car, opts, log) {
    this.opts = opts;
    this.log = log;
    this.car = car;
    /** @type {Shift|null} */
    this.last = null;
    this.peak = 0;
    this.peakT = 0;
    this.limiterHits = 0;
    /** @type {Array<[number, number, number]>} */
    this.recent = []; // [t, rpm, speed], the last ~1.2 s
    /** @type {number|null} */
    this.lastGear = null;
    this.onLimiter = false;
    car.onSample(
      (d, t) => this._sample(d, t),
      () => {
        this.recent.length = 0;
        this.lastGear = null;
      },
    );
  }

  /** @returns {number} the shift point with the oil warm */
  _normal() {
    const o = this.opts();
    return Math.max(2500, o.redline - o.shiftBefore);
  }

  /**
   * The shift point right now: lowered while the oil is cold (cold guard on).
   * @param {number} [oil] deg C
   * @returns {{ rpm: number, cold: boolean }}
   */
  shiftPoint(oil) {
    const n = this._normal();
    if (!this.opts().coldGuard || !isNum(oil) || oil >= WARM_OIL)
      return { rpm: n, cold: false };
    const cold = Math.min(COLD_LIMIT, n);
    const f = clamp((oil - 30) / (WARM_OIL - 30), 0, 1);
    return { rpm: Math.round((cold + (n - cold) * f) / 50) * 50, cold: true };
  }

  /**
   * @param {number} rpm
   * @param {number} target the shift point
   * @param {boolean} cold the cold guard holds the shift point down
   * @returns {string}
   */
  verdict(rpm, target, cold) {
    const red = this.opts().redline;
    return rpm >= red - 60
      ? "LIMITER"
      : rpm < target - 250
        ? "EARLY"
        : rpm > target + 200
          ? cold
            ? "COLD REV"
            : "LATE"
          : "SPOT ON";
  }

  /**
   * Scores an upshift on the highest rpm in the 0.6 s before it.
   * @param {number} t sample time, ms
   * @param {number|string} from
   * @param {number|string} to
   */
  _record(t, from, to) {
    const win = this.recent.filter((r) => t - r[0] < 600);
    if (!win.length) return;
    const rpm = Math.max.apply(
      null,
      win.map((r) => r[1]),
    );
    if (!(rpm > 2500)) return;
    const sp = this.shiftPoint(this.car.data().oil);
    this.last = {
      at: Date.now(),
      from,
      to,
      rpm: Math.round(rpm),
      target: sp.rpm,
      verdict: this.verdict(rpm, sp.rpm, sp.cold),
    };
    this.log.info(
      "shift " +
        from +
        "->" +
        to +
        " @" +
        this.last.rpm +
        " (shift point " +
        sp.rpm +
        ") " +
        this.last.verdict,
    );
  }

  /**
   * @param {CarData} d
   * @param {number} t sample time, ms
   */
  _sample(d, t) {
    if (!isNum(d.rpm)) return;
    const r = this.recent;
    r.push([t, d.rpm, d.speed]);
    while (r.length && t - r[0][0] > 1200) r.shift();
    const now = Date.now();
    if (d.rpm >= this.peak || now - this.peakT > PEAK_HOLD_MS) {
      this.peak = d.rpm;
      this.peakT = now;
    }
    const lim = d.rpm >= this.opts().redline - 60;
    if (lim && !this.onLimiter) this.limiterHits++;
    this.onLimiter = lim;
    const g = d.gear;
    if (
      isNum(g) &&
      g > 0 &&
      isNum(this.lastGear) &&
      this.lastGear > 0 &&
      g === this.lastGear + 1
    )
      this._record(t, this.lastGear, g);
    else if (!isNum(g) && r.length > 4 && d.speed > 10) {
      const back = r.filter((x) => t - x[0] < 400);
      const hi = Math.max.apply(
        null,
        back.map((x) => x[1]),
      );
      if (
        hi > 3000 &&
        d.rpm < hi * 0.82 &&
        (!this.last || now - this.last.at > 800)
      )
        this._record(t, "?", "?");
    }
    if (isNum(g)) this.lastGear = g;
  }
}

module.exports = ShiftScore;
