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
  DEFAULT_TANK_L,
  FRESH_MS,
  MI_PER_KM,
  PRESS_TO_BAR,
  PSI_PER_BAR,
  SETUP,
  SETUP_LEVEL,
  VOLT_MS,
} = require("./consts");
const { SPEED_SCALE, scaleFrac } = require("./scales");
const { isNum } = require("../engine/util");
const { WARM_OIL } = require("../shift_score");

const FILTER_DT_MAX_MS = 500; // a smoothing filter's step at most (after a pause)
const RPM_TAU_MS = 120; // the rpm filter
const RPM_MOVE_MIN = 40; // the rpm readout moves only by this much or more
const RPM_STEP = 50; // the rpm readout's steps
const REV_SCALE_STEP_RPM = 1000; // the rev scale's top: the redline rounded up to this
const RED_MIN_RPM = 500; // the red mark covers at least the scale's last this many rpm
const ORANGE_RPM = 700; // the orange mark: this many rpm before the red
const SPEED_STEPS = 8; // label steps on SPEED_SCALE
const DEFAULT_TORQUE_NM = 500; // config.engine.torqueNm when unset (an M40i)
const DEFAULT_POWER_KW = 285; // config.engine.powerKw when unset (an M40i)
const NM_RPM_PER_KW = 9549; // kW = Nm x rpm / 9549
const PEDAL_OBD_FRESH_MS = 1000; // the OBD pedal reading counts this long
const DEFAULT_PEDAL_FACTOR = 0.025; // config.pedal.factor when unset
const DEFAULT_KICKDOWN_PCT = 87; // config.pedal.kickdown when unset
const BRAKE10_MAX = 10; // brake10's full bar
const VOLT_STALE_READS = 3; // the 12 V reading is stale after this many VOLT_MS intervals
const TPMS_PRESS_NONE = 65532; // a TPMS pressure raw at or past this: none
const TPMS_PRESS_PER_UNIT = 10; // a TPMS pressure raw is 0.1 x the car's unit
// plausible tyre pressures by unit, when the car's unit is not known
const TYRE_BAR_MIN = 0.5,
  TYRE_BAR_MAX = 6;
const TYRE_PSI_MIN = 7,
  TYRE_PSI_MAX = 60; // also where kPa starts
const TYRE_KPA_MAX = 600;
const TPMS_TEMP_NONE = 65535; // a TPMS temperature raw at or past this: none
const TPMS_TEMP_OFFSET = 40; // a TPMS temperature raw is the car's degrees + 40
const ODO_DT_MAX_MS = 1000; // the odometer's step at most (after a pause)
const ODO_FRAC_MAX = 0.999; // the distance since the car's last km stays under the next km
const DEFAULT_CONS_FACTOR = 0.1; // config.consumption.factor when unset
const MPG_US_L100 = 235.215; // mpg (US) = this / l/100km
const MPG_UK_L100 = 282.481; // mpg (UK) = this / l/100km
// the demo drive's made-up values
const DEMO_FUEL_FRAC = 0.62;
const DEMO_RANGE_KM = 368;
const DEMO_AMBIENT_C = 24;
const DEMO_BOOST_BAR = 1.3; // at full throttle
const DEMO_BOOST_FROM_RPM = 1500,
  DEMO_BOOST_SPAN_RPM = 2000; // boost builds from 1500 to 3500 rpm
const DEMO_BRAKE_G = -0.12; // the brake lights come on under this gLong
const DEMO_BATT_PCT = 82;
const DEMO_RUNNING_RPM = 400; // over this the engine runs
const DEMO_VOLT_RUNNING = 14.1,
  DEMO_VOLT_OFF = 12.6;
const DEMO_TYRE_BAR_FRONT = 2.3,
  DEMO_TYRE_BAR_REAR = 2.5;
const DEMO_TYRE_C_FRONT = 24,
  DEMO_TYRE_C_REAR = 27;
const DEMO_ODO_KM = 23817;
const DEMO_L100 = 9.8;

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
    const dt = this.lastTickT ? Math.min(FILTER_DT_MAX_MS, now - this.lastTickT) : 0;
    this.lastTickT = now;
    if (!isNum(raw)) {
      this.rpmF = null;
      this.rpmShown = null;
      return;
    }
    this.rpmF = isNum(this.rpmF)
      ? this.rpmF + (raw - this.rpmF) * (1 - Math.exp(-dt / RPM_TAU_MS))
      : raw;
    if (!isNum(this.rpmShown) || Math.abs(this.rpmF - this.rpmShown) >= RPM_MOVE_MIN)
      this.rpmShown = Math.max(0, Math.round(this.rpmF / RPM_STEP) * RPM_STEP);
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
          ? Math.min(1, this.fuelL / (this.config.tankLitres || DEFAULT_TANK_L))
          : demo
            ? DEMO_FUEL_FRAC
            : null;
      if (name === "range")
        return isNum(this.rangeKm) ? this.rangeKm : demo ? DEMO_RANGE_KM : null;
      return isNum(this.ambient) ? this.ambient : demo ? DEMO_AMBIENT_C : null;
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
        return (Math.max(0, data.torque) / (engine.torqueNm || DEFAULT_TORQUE_NM)) * 100;
      return isNum(data.rpm)
        ? ((Math.max(0, data.torque) * data.rpm) /
            NM_RPM_PER_KW /
            (engine.powerKw || DEFAULT_POWER_KW)) *
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
      Math.ceil(this.setting("redline") / REV_SCALE_STEP_RPM) *
        REV_SCALE_STEP_RPM +
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
    shift.oilCold = isNum(data.oil) && data.oil < WARM_OIL;
    return shift;
  },

  /** Where the red and orange marks start on a rev scale that ends at `max` rpm, as fractions 0..1: red from the
   *  redline, but always covering at least the last 500 rpm (the M40i's scale ends right at its 7000 redline),
   *  orange over the 700 rpm before the red.
   * @param {number} max rpm
   * @returns {number[]} [red, orange]
   */
  _redMarks(max) {
    const redFrom = Math.min(this.setting("redline"), max - RED_MIN_RPM) / max;
    return [redFrom, redFrom - ORANGE_RPM / max];
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
        usUnits ? speed * MI_PER_KM : speed,
        SPEED_SCALE[usUnits ? "us" : "metric"],
      ) * SPEED_STEPS
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
        DEMO_BOOST_BAR *
        Math.min(
          1,
          Math.max(0, (data.rpm - DEMO_BOOST_FROM_RPM) / DEMO_BOOST_SPAN_RPM),
        )
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
      if (isNum(this.pedalObd) && Date.now() - this.pedalObdAt < PEDAL_OBD_FRESH_MS)
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
          this.pedal.raw * (isNum(pedalCfg.factor) ? pedalCfg.factor : DEFAULT_PEDAL_FACTOR) +
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
      Date.now() - this.pedalObdAt < PEDAL_OBD_FRESH_MS
    )
      return (
        this.pedalObd >= (isNum(pedalCfg.kickdown) ? pedalCfg.kickdown : DEFAULT_KICKDOWN_PCT)
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
    return !!data.demo && isNum(data.gLong) && data.gLong < DEMO_BRAKE_G;
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
      const dt = this.decelAt ? Math.min(FILTER_DT_MAX_MS, now - this.decelAt) : 0;
      this.decelF = isNum(this.decelF)
        ? this.decelF +
          (decel - this.decelF) * (1 - Math.exp(-dt / BRAKE_TAU_MS))
        : decel;
      this.decelAt = now;
    } else this.decelF = null;
    if (!this._brake()) return 0;
    if (!isNum(this.decelF)) return BRAKE10_MAX;
    const level =
      (BRAKE10_MAX * Math.log(1 + Math.min(this.decelF, BRAKE_GMAX) / BRAKE_G0)) /
      Math.log(1 + BRAKE_GMAX / BRAKE_G0);
    return Math.max(1, Math.min(BRAKE10_MAX, level));
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
    return this.car.data().demo ? DEMO_BATT_PCT : null;
  },

  /**
   * The 12 V system in V, null when the engine unit has not answered lately; the demo drive's made up.
   * @returns {?number}
   */
  _volt12() {
    if (isNum(this.volt12) && Date.now() - this.volt12At < VOLT_MS * VOLT_STALE_READS)
      return this.volt12;
    const data = this.car.data();
    return data.demo
      ? isNum(data.rpm) && data.rpm > DEMO_RUNNING_RPM
        ? DEMO_VOLT_RUNNING
        : DEMO_VOLT_OFF
      : null;
  },

  /** A tyre's pressure ('p', bar) or temperature ('t', C) at corner FL FR RL RR; steady made-up values on the demo drive. */
  /** A TPMS pressure raw (0.1 x the car's unit, 65532 and up = none) in bar: by the car's unit when known, else by the
   *  unit whose plausible tyre pressures the value falls in (bar 0.5-6, psi 7-60, kPa 60-600; psi also means F).
   * @param {unknown} raw
   * @returns {?number}
   */
  _tyreBar(raw) {
    if (!isNum(raw) || raw < 0 || raw >= TPMS_PRESS_NONE) return null;
    const value = raw / TPMS_PRESS_PER_UNIT,
      k = PRESS_TO_BAR[this.carUnits.press];
    if (k) return value * k;
    if (value >= TYRE_BAR_MIN && value <= TYRE_BAR_MAX) return value;
    if (value >= TYRE_PSI_MIN && value < TYRE_PSI_MAX) {
      this.carUnits.psiSeen = true;
      return value / PSI_PER_BAR;
    }
    if (value >= TYRE_PSI_MAX && value <= TYRE_KPA_MAX) return value / 100;
    return value;
  },

  /**
   * A TPMS temperature raw (the car's degrees + 40, 65535 = none) in C (the car sends F when set to F).
   * @param {unknown} raw
   * @returns {?number}
   */
  _tyreC(raw) {
    if (!isNum(raw) || raw < 0 || raw >= TPMS_TEMP_NONE) return null;
    const temp = raw - TPMS_TEMP_OFFSET,
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
    return kind === "p"
      ? rear
        ? DEMO_TYRE_BAR_REAR
        : DEMO_TYRE_BAR_FRONT
      : rear
        ? DEMO_TYRE_C_REAR
        : DEMO_TYRE_C_FRONT;
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
    const dt = this.odoAt
      ? Math.min(ODO_DT_MAX_MS, Math.max(0, now - this.odoAt))
      : 0;
    this.odoAt = now;
    const speed = this._raw("speed");
    if (isNum(speed) && speed > 0) this.odoAcc += (speed * dt) / 3600000;
    // KombiIF's whole km, else MileageSupreme's (no longer asked for: it never came on the car)
    const base = isNum(this.odoKm) ? this.odoKm : this.mileage;
    if (isNum(base)) {
      this.odoAcc = Math.min(this.odoAcc, ODO_FRAC_MAX);
      return base + this.odoAcc;
    }
    return this.car.data().demo ? DEMO_ODO_KM + this.odoAcc : null;
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
        this.consBc * (isNum(consCfg.factor) ? consCfg.factor : DEFAULT_CONS_FACTOR) +
        (isNum(consCfg.offset) ? consCfg.offset : 0);
    } else
      return this.car.data().demo
        ? this.setting("units") === "us"
          ? MPG_US_L100 / DEMO_L100
          : DEMO_L100
        : null;
    // the car sends it in its own unit: to l/100km, then to the units setting's (mpg US or l/100km)
    const unit =
      isNum(this.consUnit) && this.consUnit > 0
        ? this.consUnit
        : this.consUnitBc;
    const l100 = !(avg > 0)
      ? null
      : unit === CONS_UNIT.CONSUMPTION_US
        ? MPG_US_L100 / avg
        : unit === CONS_UNIT.CONSUMPTION_UK
          ? MPG_UK_L100 / avg
          : unit === CONS_UNIT.CONSUMPTION_KML
            ? 100 / avg
            : avg;
    if (!isNum(l100)) return null;
    return this.setting("units") === "us" ? MPG_US_L100 / l100 : l100;
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
