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
/** @type {(value: any) => value is number} */
const isNum = (value) => typeof value === "number" && isFinite(value);
/** @type {(value: number, min: number, max: number) => number} */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
      (data, t) => this._sample(data, t),
      () => {
        this.recent.length = 0;
        this.lastGear = null;
      },
    );
  }

  /** @returns {number} the shift point with the oil warm */
  _normal() {
    const opts = this.opts();
    return Math.max(2500, opts.redline - opts.shiftBefore);
  }

  /**
   * The shift point right now: lowered while the oil is cold (cold guard on).
   * @param {number} [oil] deg C
   * @returns {{ rpm: number, cold: boolean }}
   */
  shiftPoint(oil) {
    const normal = this._normal();
    if (!this.opts().coldGuard || !isNum(oil) || oil >= WARM_OIL)
      return { rpm: normal, cold: false };
    const cold = Math.min(COLD_LIMIT, normal);
    const warmth = clamp((oil - 30) / (WARM_OIL - 30), 0, 1);
    return {
      rpm: Math.round((cold + (normal - cold) * warmth) / 50) * 50,
      cold: true,
    };
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
    const win = this.recent.filter((sample) => t - sample[0] < 600);
    if (!win.length) return;
    const rpm = Math.max.apply(
      null,
      win.map((sample) => sample[1]),
    );
    if (!(rpm > 2500)) return;
    const point = this.shiftPoint(this.car.data().oil);
    this.last = {
      at: Date.now(),
      from,
      to,
      rpm: Math.round(rpm),
      target: point.rpm,
      verdict: this.verdict(rpm, point.rpm, point.cold),
    };
    this.log.info(
      "shift " +
        from +
        "->" +
        to +
        " @" +
        this.last.rpm +
        " (shift point " +
        point.rpm +
        ") " +
        this.last.verdict,
    );
  }

  /**
   * @param {CarData} data
   * @param {number} t sample time, ms
   */
  _sample(data, t) {
    if (!isNum(data.rpm)) return;
    const recent = this.recent;
    recent.push([t, data.rpm, data.speed]);
    while (recent.length && t - recent[0][0] > 1200) recent.shift();
    const now = Date.now();
    if (data.rpm >= this.peak || now - this.peakT > PEAK_HOLD_MS) {
      this.peak = data.rpm;
      this.peakT = now;
    }
    const lim = data.rpm >= this.opts().redline - 60;
    if (lim && !this.onLimiter) this.limiterHits++;
    this.onLimiter = lim;
    const gear = data.gear;
    if (
      isNum(gear) &&
      gear > 0 &&
      isNum(this.lastGear) &&
      this.lastGear > 0 &&
      gear === this.lastGear + 1
    )
      this._record(t, this.lastGear, gear);
    else if (!isNum(gear) && recent.length > 4 && data.speed > 10) {
      const back = recent.filter((sample) => t - sample[0] < 400);
      const peakRpm = Math.max.apply(
        null,
        back.map((sample) => sample[1]),
      );
      if (
        peakRpm > 3000 &&
        data.rpm < peakRpm * 0.82 &&
        (!this.last || now - this.last.at > 800)
      )
        this._record(t, "?", "?");
    }
    if (isNum(gear)) this.lastGear = gear;
  }
}

module.exports = ShiftScore;
