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
 * @property {string} [program] the shifter programme from the gearbox status: "D", "S" or "M"
 * @property {number} [throttle] 0..1, the demo drive's own (the car sends none here)
 * @property {boolean} [gearGuessed] the gear learnt from rpm / speed, the car sent none
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
const COLD_OIL_C = 30; // the oil temperature the cold guard's COLD_LIMIT holds at
const MIN_SHIFT_RPM = 2500; // the lowest shift point; shifts under it aren't scored
const SHIFT_STEP_RPM = 50; // the cold shift point climbs in these steps
const LIMITER_RPM = 60; // within this of the redline is the limiter
const EARLY_RPM = 250; // over this under the shift point is EARLY
const LATE_RPM = 200; // over this above the shift point is LATE
const SHIFT_WINDOW_MS = 600; // a shift is scored on the highest rpm in this window before it
const RECENT_MS = 1200; // the samples kept
const DROP_WINDOW_MS = 400; // with no gear signal: the window the rpm drop is looked for in
const DROP_MIN_SAMPLES = 4; // samples needed before looking for an rpm drop
const DROP_MIN_KMH = 10; // moving: rpm drops count above this speed
const DROP_MIN_RPM = 3000; // the peak an rpm drop must start from
const DROP_FRAC = 0.82; // the rpm falls under this share of the peak (over 18 %)
const SHIFT_GAP_MS = 800; // the least time between two guessed shifts
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
    return Math.max(MIN_SHIFT_RPM, opts.redline - opts.shiftBefore);
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
    const warmth = clamp((oil - COLD_OIL_C) / (WARM_OIL - COLD_OIL_C), 0, 1);
    return {
      rpm: Math.round((cold + (normal - cold) * warmth) / SHIFT_STEP_RPM) * SHIFT_STEP_RPM,
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
    return rpm >= red - LIMITER_RPM
      ? "LIMITER"
      : rpm < target - EARLY_RPM
        ? "EARLY"
        : rpm > target + LATE_RPM
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
    const win = this.recent.filter((sample) => t - sample[0] < SHIFT_WINDOW_MS);
    if (!win.length) return;
    const rpm = Math.max.apply(
      null,
      win.map((sample) => sample[1]),
    );
    if (!(rpm > MIN_SHIFT_RPM)) return;
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
    while (recent.length && t - recent[0][0] > RECENT_MS) recent.shift();
    const now = Date.now();
    if (data.rpm >= this.peak || now - this.peakT > PEAK_HOLD_MS) {
      this.peak = data.rpm;
      this.peakT = now;
    }
    const lim = data.rpm >= this.opts().redline - LIMITER_RPM;
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
    else if (!isNum(gear) && recent.length > DROP_MIN_SAMPLES && data.speed > DROP_MIN_KMH) {
      const back = recent.filter((sample) => t - sample[0] < DROP_WINDOW_MS);
      const peakRpm = Math.max.apply(
        null,
        back.map((sample) => sample[1]),
      );
      if (
        peakRpm > DROP_MIN_RPM &&
        data.rpm < peakRpm * DROP_FRAC &&
        (!this.last || now - this.last.at > SHIFT_GAP_MS)
      )
        this._record(t, "?", "?");
    }
    if (isNum(gear)) this.lastGear = gear;
  }
}

ShiftScore.WARM_OIL = WARM_OIL; // the oil warm enough for the full shift point (car/values.js reads it too)
module.exports = ShiftScore;
