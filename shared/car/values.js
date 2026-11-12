"use strict";
/**
 * Values derived from the car's data: rpm smoothing, the shift point and rev scale, boost, pedals, brake,
 * 12 V, tyres, the odometer, consumption, the drive mode's setup.
 *
 * rpm is smoothed (a 120 ms filter, and the readout moves in 50 rpm steps only when it changes by 40 or
 * more), so idle wobble doesn't show, as on BMW's own tach. Shift scoring uses the raw rpm.
 * Boost: FES displayBoostPressure while it's valid, else (app.json config.dme) the engine unit over
 * read-only UDS, absolute pressure minus outside air pressure, as cauliflowermossgrape's car_vitals does.
 *
 *
 * Boost is a PUSH signal, not a diagnostic poll: tracing cauliflowermossgrape's
 * car_vitals showed its boost reading is de.bmw.infotainment.drivingexcitement.FES /
 * statusSwitchDriveDynamicSport2.displayBoostPressure, factor 0.01, offset 0,
 * invalid 255. car_vitals itself treats that field as unreliable on some cars, so
 * whether this X3 fills it is checked on the first drive. Reported here in bar.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const {
  BRAKE_G0,
  BRAKE_GMAX,
  BRAKE_TAU_MS,
  CONS_UNIT,
  FRESH_MS,
  PRESS_TO_BAR,
  SETUP,
  SETUP_LEVEL,
  VOLT_MS,
} = require("./consts");
const { SPEED_SCALE, scaleFrac } = require("./scales");
const { isNum } = require("../engine/util");

/** @typedef {import("../engine/app").Widget} Widget */
/** @typedef {import("./consts").ShiftPoint} ShiftPoint */
/** @typedef {import("./consts").CarData} CarData */

/** @typedef {import("./consts").SetupRows} SetupRows */
/**
 * The consumption log on the app (App, through app_type.d.ts).
 * @typedef {object} ValuesState
 * @property {Record<string, string>} [consLines] the consumption messages last logged, by kind
 */

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /**
   * BMW-like tach: a 120 ms filter, and a readout that moves in 50 rpm steps, only by 40 rpm or more.
   * @param {number} now
   * @returns {void}
   */
  _smoothRpm(now) {
    const raw = this.car.data().rpm;
    const dt = this.lastTickT ? Math.min(500, now - this.lastTickT) : 0;
    this.lastTickT = now;
    if (!isNum(raw)) {
      this.rpmF = null;
      this.rpmShown = null;
      return;
    }
    this.rpmF = isNum(this.rpmF)
      ? this.rpmF + (raw - this.rpmF) * (1 - Math.exp(-dt / 120))
      : raw;
    if (!isNum(this.rpmShown) || Math.abs(this.rpmF - this.rpmShown) >= 40)
      this.rpmShown = Math.max(0, Math.round(this.rpmF / 50) * 50);
  },

  /**
   * A signal's value by name: hud's own (boost, fuel, throttle10,
   * setupLevel:<part>, ...) or the car data's.
   * @param {string} name
   * @returns {?(number | string | boolean)} a number for every gauge signal; the car data's other fields as they are
   */
  _raw(name) {
    if (name === "boost") return this._boost();
    if (name === "rpm" && isNum(this.rpmF)) return this.rpmF;
    if (name === "fuel" || name === "range" || name === "ambient") {
      // the kit's demo drive has none of these: made-up but steady values while it runs
      const demo = this.car.data().demo;
      if (name === "fuel")
        return isNum(this.fuelL)
          ? Math.min(1, this.fuelL / (this.config.tankLitres || 65))
          : demo
            ? 0.62
            : null;
      if (name === "range")
        return isNum(this.rangeKm) ? this.rangeKm : demo ? 368 : null;
      return isNum(this.ambient) ? this.ambient : demo ? 24 : null;
    }
    if (name === "torquePct" || name === "powerPct") {
      // the car's own sport display % while it sends one, else from the crank torque and app.json
      // config.engine's peaks (an M40i makes 500 Nm, 285 kW)
      if (Date.now() - (this.sportAt || 0) < FRESH_MS) {
        const pct = name === "powerPct" ? this.sportPower : this.sportTorque;
        if (isNum(pct)) return pct;
      }
      const engine = this.config.engine || {},
        data = this.car.data();
      if (!isNum(data.torque)) return null;
      if (name === "torquePct")
        return (Math.max(0, data.torque) / (engine.torqueNm || 500)) * 100;
      return isNum(data.rpm)
        ? ((Math.max(0, data.torque) * data.rpm) /
            9549 /
            (engine.powerKw || 285)) *
            100
        : null;
    }
    if (name.indexOf("setupLevel:") === 0) {
      const setup = this._setup();
      return setup ? SETUP_LEVEL[setup[name.slice(11)]] || 0 : 0;
    }
    if (name === "throttle" || name === "throttle10") {
      const throttle = this._throttle();
      return isNum(throttle)
        ? name === "throttle"
          ? throttle
          : throttle / 10
        : null;
    }
    if (name === "brake10") return this._brakeLevel();
    if (name === "volt12") return this._volt12();
    if (name === "batt12") return this._batt12();
    const data = this.car.data();
    return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : null;
  },

  /**
   * The rev scale's top: the redline rounded up to 1000 rpm, plus "over".
   * @param {Widget} [widget]
   * @returns {number}
   */
  _barMax(widget) {
    return (
      Math.ceil(this.setting("redline") / 1000) * 1000 +
      ((widget && widget.over) || 0)
    );
  },

  /**
   * The shift point now ({ rpm, cold }) and whether the rpm is at or past it.
   * @returns {ShiftPoint}
   */
  _shift() {
    const data = this.car.data();
    const shift = this.score.shiftPoint(data.oil);
    const rpm = isNum(this.rpmF) ? this.rpmF : data.rpm;
    shift.now = isNum(rpm) && rpm >= shift.rpm;
    shift.oilCold = isNum(data.oil) && data.oil < 80;
    return shift;
  },

  /** Where the red and orange marks start on a rev scale that ends at `max` rpm, as fractions 0..1: red from the
   *  redline, but always covering at least the last 500 rpm (the M40i's scale ends right at its 7000 redline),
   *  orange over the 700 rpm before the red.
   * @param {number} max rpm
   * @returns {number[]} [red, orange]
   */
  _redMarks(max) {
    const redFrom = Math.min(this.setting("redline"), max - 500) / max;
    return [redFrom, redFrom - 700 / max];
  },

  /**
   * The scale label nearest the value now: 'speed' (SPEED_SCALE index) or 'rpm' (thousands); null without data.
   * @param {string} kind 'speed' or 'rpm'
   * @returns {?number}
   */
  _nearMark(kind) {
    const pos = this._nearPos(kind);
    return isNum(pos) ? Math.round(pos) : null;
  },

  /**
   * Where the value sits on a scale, in label steps (2.5 = halfway between labels 2 and 3); null without one.
   * @param {string} kind 'speed' or 'rpm'
   * @returns {?number}
   */
  _nearPos(kind) {
    if (kind === "rpm") {
      const rpm = this._raw("rpm");
      return isNum(rpm) ? rpm / 1000 : null;
    }
    const speed = this._raw("speed");
    if (!isNum(speed)) return null;
    const usUnits = this.setting("units") === "us";
    return (
      scaleFrac(
        usUnits ? speed * 0.621371 : speed,
        SPEED_SCALE[usUnits ? "us" : "metric"],
      ) * 8
    );
  },

  /**
   * Boost in bar: the sport display's value while fresh, else the engine unit's, else null.
   * @returns {?number}
   */
  _boost() {
    const now = Date.now();
    if (isNum(this.boostFes) && now - this.boostFesAt < FRESH_MS)
      return this.boostFes;
    if (isNum(this.boostDme) && now - this.boostDmeAt < FRESH_MS)
      return this.boostDme;
    // the demo drive: made up from the throttle, building from 1500 to 3500 rpm (up to 1.3 bar)
    const data = this.car.data();
    if (data.demo && isNum(data.throttle) && isNum(data.rpm))
      return (
        Math.max(0, data.throttle) *
        1.3 *
        Math.min(1, Math.max(0, (data.rpm - 1500) / 2000))
      );
    return null;
  },

  /** The accelerator pedal 0..100 % (raw * config.pedal.factor), null when not valid or older than 3 s; the demo drive's
   *  own (sim.js throttle 0..1).
   * @returns {?number}
   */
  _throttle() {
    const pedalCfg = this.config.pedal || {};
    if (pedalCfg.source === "obd") {
      // OBD PID 0x49 reads its own %, mapped from config.pedal.obdRange [at rest, flat out] to 0..100
      const range =
        Array.isArray(pedalCfg.obdRange) && pedalCfg.obdRange.length === 2
          ? pedalCfg.obdRange
          : [0, 100];
      if (isNum(this.pedalObd) && Date.now() - this.pedalObdAt < 1000)
        return Math.max(
          0,
          Math.min(
            100,
            ((this.pedalObd - range[0]) / (range[1] - range[0])) * 100,
          ),
        );
      const data = this.car.data();
      return data.demo
        ? isNum(data.throttle)
          ? Math.max(0, Math.min(100, data.throttle * 100))
          : 0
        : null;
    }
    if (this.pedal && Date.now() - this.pedal.at < FRESH_MS) {
      const pedalCfg = this.config.pedal || {};
      return Math.max(
        0,
        Math.min(
          100,
          this.pedal.raw * (isNum(pedalCfg.factor) ? pedalCfg.factor : 0.025) +
            (isNum(pedalCfg.offset) ? pedalCfg.offset : 0),
        ),
      );
    }
    const data = this.car.data();
    return data.demo
      ? isNum(data.throttle)
        ? Math.max(0, Math.min(100, data.throttle * 100))
        : 0
      : null;
  },

  /** The pedal in kickdown: the OBD pedal at or past config.pedal.kickdown (87 %: an X3 M40i reads 82 flat out and 91 in
   *  kickdown); the demo drive's at full throttle.
   * @returns {boolean}
   */
  _kickdown() {
    const pedalCfg = this.config.pedal || {};
    if (
      pedalCfg.source === "obd" &&
      isNum(this.pedalObd) &&
      Date.now() - this.pedalObdAt < 1000
    )
      return (
        this.pedalObd >= (isNum(pedalCfg.kickdown) ? pedalCfg.kickdown : 87)
      );
    const data = this.car.data();
    return !!data.demo && isNum(data.throttle) && data.throttle >= 1;
  },

  /**
   * The brake lights on; the demo drive's while it slows down.
   * @returns {boolean}
   */
  _brake() {
    if (this.brakeOn !== null) return this.brakeOn;
    const data = this.car.data();
    return !!data.demo && isNum(data.gLong) && data.gLong < -0.12;
  },

  /** The brake bar 0..10: 0 off; while braking the deceleration on a log scale (BRAKE_G0, BRAKE_GMAX), at least 1; 10
   *  without a deceleration reading. The deceleration is smoothed over BRAKE_TAU_MS so the bar does not flicker.
   * @returns {number}
   */
  _brakeLevel() {
    const now = Date.now(),
      gLong = this.car.data().gLong;
    const decel = isNum(gLong) ? Math.max(0, -gLong) : null;
    if (isNum(decel)) {
      const dt = this.decelAt ? Math.min(500, now - this.decelAt) : 0;
      this.decelF = isNum(this.decelF)
        ? this.decelF +
          (decel - this.decelF) * (1 - Math.exp(-dt / BRAKE_TAU_MS))
        : decel;
      this.decelAt = now;
    } else this.decelF = null;
    if (!this._brake()) return 0;
    if (!isNum(this.decelF)) return 10;
    const level =
      (10 * Math.log(1 + Math.min(this.decelF, BRAKE_GMAX) / BRAKE_G0)) /
      Math.log(1 + BRAKE_GMAX / BRAKE_G0);
    return Math.max(1, Math.min(10, level));
  },

  /**
   * The 12 V battery's charge 0..100 % (raw * config.battery.factor), null when not sent; the demo drive's made up.
   * @returns {?number}
   */
  _batt12() {
    if (isNum(this.battRaw)) {
      const batteryCfg = this.config.battery || {};
      return Math.max(
        0,
        Math.min(
          100,
          this.battRaw * (isNum(batteryCfg.factor) ? batteryCfg.factor : 1) +
            (isNum(batteryCfg.offset) ? batteryCfg.offset : 0),
        ),
      );
    }
    return this.car.data().demo ? 82 : null;
  },

  /**
   * The 12 V system in V, null when the engine unit has not answered lately; the demo drive's made up.
   * @returns {?number}
   */
  _volt12() {
    if (isNum(this.volt12) && Date.now() - this.volt12At < VOLT_MS * 3)
      return this.volt12;
    const data = this.car.data();
    return data.demo ? (isNum(data.rpm) && data.rpm > 400 ? 14.1 : 12.6) : null;
  },

  /** A tyre's pressure ('p', bar) or temperature ('t', C) at corner FL FR RL RR; steady made-up values on the demo drive. */
  /** A TPMS pressure raw (0.1 x the car's unit, 65532 and up = none) in bar: by the car's unit when known, else by the
   *  unit whose plausible tyre pressures the value falls in (bar 0.5-6, psi 7-60, kPa 60-600; psi also means F).
   * @param {unknown} raw
   * @returns {?number}
   */
  _tyreBar(raw) {
    if (!isNum(raw) || raw < 0 || raw >= 65532) return null;
    const value = raw / 10,
      k = PRESS_TO_BAR[this.carUnits.press];
    if (k) return value * k;
    if (value >= 0.5 && value <= 6) return value;
    if (value >= 7 && value < 60) {
      this.carUnits.psiSeen = true;
      return value / 14.5038;
    }
    if (value >= 60 && value <= 600) return value / 100;
    return value;
  },

  /**
   * A TPMS temperature raw (the car's degrees + 40, 65535 = none) in C (the car sends F when set to F).
   * @param {unknown} raw
   * @returns {?number}
   */
  _tyreC(raw) {
    if (!isNum(raw) || raw < 0 || raw >= 65535) return null;
    const temp = raw - 40,
      fahrenheit = this.carUnits.temp
        ? this.carUnits.temp === "F"
        : this.carUnits.psiSeen;
    return fahrenheit ? ((temp - 32) * 5) / 9 : temp;
  },

  /**
   * A tyre's pressure ('p', bar) or temperature ('t', C) at a corner; steady
   * made-up values on the demo drive.
   * @param {string} kind 'p' or 't'
   * @param {string} corner FL FR RL RR
   * @returns {?number}
   */
  _tyre(kind, corner) {
    const value = this.tyres[kind][corner];
    if (isNum(value)) return value;
    if (!this.car.data().demo) return null;
    const rear = corner === "RL" || corner === "RR";
    return kind === "p" ? (rear ? 2.5 : 2.3) : rear ? 27 : 24;
  },

  /**
   * The shifter programme letter next to the gear: S or M from the M drive display, else from the gearbox status, else D.
   * @param {CarData & { program?: string }} data
   * @returns {string}
   */
  _program(data) {
    const program = this.program || data.program;
    return program === "S" || program === "M" ? program : "D";
  },

  /**
   * The odometer in km, between the car's whole-km readings too: the distance driven since its last km comes from the
   * speed (kept under the next km, so the drums never pass the car's own reading). Time-based, so any number of
   * widgets may ask each tick. Null without a reading; the demo drive starts at 23817 km.
   * @param {number} [now] ms
   * @returns {?number} km
   */
  _odometer(now) {
    if (!isNum(now)) now = Date.now();
    const dt = this.odoAt ? Math.min(1000, Math.max(0, now - this.odoAt)) : 0;
    this.odoAt = now;
    const speed = this._raw("speed");
    if (isNum(speed) && speed > 0) this.odoAcc += (speed * dt) / 3600000;
    // KombiIF's whole km, else MileageSupreme's (no longer asked for: it never came on the car)
    const base = isNum(this.odoKm) ? this.odoKm : this.mileage;
    if (isNum(base)) {
      this.odoAcc = Math.min(this.odoAcc, 0.999);
      return base + this.odoAcc;
    }
    return this.car.data().demo ? 23817 + this.odoAcc : null;
  },

  /** Average consumption for the period picked on the center screen, in the car's unit; null before the car sends it.
   *  The last value stands until the next: the car notifies it only when it changes (a 2-minute timeout here showed
   *  "--" on the car, Nov 9 2026).
   * @returns {?number}
   */
  _consumption() {
    let avg = null;
    if (isNum(this.consAvg)) avg = this.consAvg;
    else if (isNum(this.consBc)) {
      const consCfg = this.config.consumption || {};
      avg =
        this.consBc * (isNum(consCfg.factor) ? consCfg.factor : 0.1) +
        (isNum(consCfg.offset) ? consCfg.offset : 0);
    } else
      return this.car.data().demo
        ? this.setting("units") === "us"
          ? 235.215 / 9.8
          : 9.8
        : null;
    // the car sends it in its own unit: to l/100km, then to the units setting's (mpg US or l/100km)
    const unit =
      isNum(this.consUnit) && this.consUnit > 0
        ? this.consUnit
        : this.consUnitBc;
    const l100 = !(avg > 0)
      ? null
      : unit === CONS_UNIT.CONSUMPTION_US
        ? 235.215 / avg
        : unit === CONS_UNIT.CONSUMPTION_UK
          ? 282.481 / avg
          : unit === CONS_UNIT.CONSUMPTION_KML
            ? 100 / avg
            : avg;
    if (!isNum(l100)) return null;
    return this.setting("units") === "us" ? 235.215 / l100 : l100;
  },

  /**
   * The consumption's unit label, by the units setting: mpg (US) or l/100km.
   * @returns {string}
   */
  _consUnit() {
    return this.setting("units") === "us" ? "mpg" : "l/100km";
  },

  /**
   * A consumption message as sent, logged when it changes.
   * @param {string} kind
   * @param {unknown} msg
   * @returns {void}
   */
  _logCons(kind, msg) {
    const line = JSON.stringify(msg);
    this.consLines = this.consLines || {};
    if (this.consLines[kind] === line) return;
    this.consLines[kind] = line;
    this.log.info("consumption " + kind + " raw " + line);
  },

  /**
   * The setup rows for the drive mode now, or null before the car has said.
   * @returns {?SetupRows}
   */
  _setup() {
    if (!this.driveMode) return null;
    if (this.driveVariant === "individual") return SETUP.individual;
    return SETUP[
      this.driveMode === "sport" && this.driveVariant === "plus"
        ? "sportplus"
        : this.driveMode
    ];
  },
});
