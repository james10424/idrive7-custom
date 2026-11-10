"use strict";
/**
 * The car's data: the kit's Car plus the app's extra SOME/IP signals, the engine unit reads over
 * read-only UDS, BMW's guidance and media.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const Car = require("../kit/car");
const ShiftScore = require("../shift_score");
const {
  AHEAD2_MEASURED,
  AUTO_H,
  BOOST_SCALE,
  BRAKE_LIGHT,
  CONS_UNIT,
  FRESH_MS,
  GUIDANCE,
  HAND_BRAKE,
  INDICATE,
  MEDIA,
  MEDIA_ITEM,
  MODE_NAME,
  PARK_BRAKE,
  PEDAL_MS,
  PEDAL_OK,
  PRESS_UNITS,
  PROGRAMS,
  TEMP_UNITS,
  TYRE_CORNERS,
  VOLT_MS,
  driveModeOf,
  driveVariantOf,
  enumNum,
  unitName,
} = require("./consts");
const { isNum, pad2 } = require("../engine/util");

/** @typedef {import("./consts").Signals} Signals */
/** @typedef {import("./consts").Car} Car */

module.exports = {
  /**
   * The car's values, empty until the car sends them.
   * @returns {void}
   */
  _initCar() {
    /** @type {?number} */
    this.boostFes = null;
    this.boostFesAt = 0; // bar, from the sport display signal
    /** @type {?number} */
    this.boostDme = null;
    this.boostDmeAt = 0; // bar, from the engine unit (fallback)
    this.needsBoost = false; // a shown widget uses boost (the engine unit is only asked then)
    /** @type {?string} */
    this.driveMode = null; // 'comfort' | 'sport' | 'eco', once the car has said
    /** @type {?string} */
    this.driveVariant = null; // 'plus' (Sport+ / Comfort+ / Eco Pro+), 'individual', or null
    this.navActive = false; // BMW's route guidance is on (the HUD shows its own guidance then)
    /** @type {*} */
    this.navRaw = undefined; // the last guidanceState as the car sent it, for the log
    this.assistActive = false; // BMW's HUD shows its driver assistance block (ACC, DCC, STA)
    /** @type {string | undefined} */
    this.assistRaw = undefined; // the last summary of it, for the log
    /** @type {?Ahead} */
    this.ahead = null; // the car ahead, raw: { gapX, gapY, speedX, speedY, q, at } (DataFrontVehicle)
    /** @type {?Ahead2} */
    this.ahead2 = null; // { gap, q, measured, at } (GapVehicleDrivingAhead)
    /** @type {?{ v: ?number, gapM: number, at: number }} */
    this.relFromGap = null; // km/h, the gap's smoothed rate of change ({ v, gapM, at })
    /** @type {?{ raw: number, at: number }} */
    this.pedal = null; // { raw, at }: the accelerator pedal as sent, while valid
    /** @type {?boolean} */
    this.brakeOn = null; // the brake lights (true / false), null until the car says
    /** @type {?string} */
    this.turn = null; // the indicators: 'L', 'R', 'LR' (hazards) or '' (body.Light StatusFunctionsIndicators)
    this.accOn = false; // BMW's HUD has the ACC car or distance bars up (the Regal CRUISE lamp)
    /** @type {?number} */
    this.mileage = null; // the odometer as sent (MileageSupreme, taken as km)
    /** @type {?boolean} */
    this.parkBrake = null; // the parking brake set (true / false), null until the car says
    /** @type {?boolean} */
    this.parkBrakeCds = null; // the same from CDS statusHandBrake (a fallback)
    /** @type {?string} */
    this.autoHold = null; // Auto Hold: 'hold' (holding the car), 'armed', 'off', null until the car says
    /** @type {?number} */
    this.volt12 = null;
    this.volt12At = 0; // V, the 12 V system from the engine unit
    this.needsVolt = false; // a shown widget uses volt12 (the engine unit is only asked then)
    this.pedalLogged = 0;
    /** @type {?number} */
    this.pedalObd = null;
    this.pedalObdAt = 0;
    /** @type {?number} */
    this.pedalObdLogged = null; // %, the pedal from the engine unit (OBD PID 0x49)
    this.needsPedal = false; // a shown widget uses the throttle (the engine unit is only asked then)
    /** @type {?number} */
    this.decelF = null;
    this.decelAt = 0; // g, the smoothed deceleration for the brake bar
    /** @type {?number} */
    this.carOffsetMin = null; // the car's time zone, minutes from UTC, from the time the cluster shows
    /** @type {?number} */
    this.battRaw = null;
    this.battAt = 0; // the 12 V battery's charge condition as sent
    /** @type {Record<string, string>} */
    this.aheadLogged = {};
    /** @type {?number} */
    this.accSetRaw = null; // cruiseCtrlSpeedHUD as sent
    /** @type {Record<string, number>} */
    this.aheadLogAt = {};
    /** @type {{ press: ?string, temp: ?string, psiSeen: boolean }} */
    this.carUnits = { press: null, temp: null, psiSeen: false }; // the car's display units, for the TPMS values
    /** @type {?string} */
    this.program = null; // 'S' / 'M' from the MDrive gearbox display, else null (D)
    /** @type {?number} */
    this.fuelL = null;
    /** @type {?number} */
    this.rangeKm = null;
    /** @type {?number} */
    this.ambient = null; // KombiIF tank / range, outside temperature
    /** @type {?number} */
    this.odoKm = null;
    this.odoAcc = 0;
    this.odoAt = 0; // KombiIF odometer (whole km) and the distance since its last km
    /** @type {{ p: Record<string, ?number>, t: Record<string, ?number> }} */
    this.tyres = { p: {}, t: {} }; // TPMS pressure (bar) and temperature (C) per corner FL FR RL RR
  },

  /**
   * The kit Car with hud's extra signals (by app.json config), and the
   * shift scorer.
   * @returns {void}
   */
  _setupVehicleData() {
    /** @type {Signals} */
    const extra = {
      // fuel and range (cauliflowermossgrape's live_data, MIT): litres (255 = none) and km (4095 = none)
      "de.bmw.infotainment.KombiIF": {
        // the local time the cluster shows: its offset from UTC is the car's time zone (the app's own clock is UTC
        // on the car, so new Date() read 5 h ahead in Toronto, Nov 2026); follows summer time and the car's setting
        statusShowTimeDate: (v) => this._onCarClock(v),
        statusRangeTankStatus: (v) => {
          const f = v && v.fluidLevelFuelTank,
            r = v && v.range;
          this.fuelL = isNum(f) && f >= 0 && f < 255 ? f : null;
          this.rangeKm = isNum(r) && r >= 0 && r < 4095 ? r : null;
          // the odometer, whole km (cauliflowermossgrape's Live Data reads it here; MileageSupreme never came)
          const m = v && v.mileageKilometre;
          const km = isNum(m) && m > 0 && m < 16777215 ? m : null;
          if (km !== this.odoKm) {
            this.odoKm = km;
            this.odoAcc = 0;
          }
        },
      },
      // the trip computer for the period picked on the center screen (this trip, since refuelling, individual, long term):
      // average consumption (app.json config.consumption); raw values logged on change to check the scaling
      "de.bmw.infotainment.resetlogic.ResetLogic": {
        averageConsumption: (v) => {
          if (!v) return;
          const sc = v.consumptionCombustionCurrentScale,
            dg = v.consumptionCombustionCurrentDigit;
          this.consAvg =
            isNum(sc) && sc < 65535 && isNum(dg) && dg >= 0 && dg <= 3
              ? sc / Math.pow(10, dg)
              : null;
          this.consUnit = enumNum(v.combustionUnit, CONS_UNIT);
          this.consAt = Date.now();
          this._logCons("average", v);
        },
        bcDataAll: (v) => {
          if (!v) return;
          const d = v.bcData || {};
          this.consPeriod =
            d.resetOption !== undefined ? d.resetOption : v.activeResetLogic;
          this.consBc =
            isNum(d.consumptionAverage) && d.consumptionAverage < 65535
              ? d.consumptionAverage
              : null;
          if (v.bcUnits && v.bcUnits.consumption !== undefined)
            this.consUnitBc = enumNum(v.bcUnits.consumption, CONS_UNIT);
          this.consBcAt = Date.now();
          this._logCons("bc", {
            period: this.consPeriod,
            active: v.activeResetLogic,
            avg: d.consumptionAverage,
            now: d.currentConsumption,
            speed: d.speedAverage,
            units: v.bcUnits,
          });
        },
      },
      // tyre pressure and temperature per corner, in the car's own display units (_tyreBar / _tyreC).
      // The car never notifies these (BMW's own x_call only ever reads them), so they are polled.
      "de.bmw.infotainment.vehicle.TPMS": {
        $pollMs: 10000,
        statusTyrePressure: (v) =>
          TYRE_CORNERS.forEach((k) => {
            this.tyres.p[k] = this._tyreBar(
              v && v["actualValuePressureTyre" + k + "H"],
            );
          }),
        statusTyreTemperature: (v) =>
          TYRE_CORNERS.forEach((k) => {
            this.tyres.t[k] = this._tyreC(
              v && v["actualValueTemperatureTyre" + k + "H"],
            );
          }),
      },
      // the car's display units: the TPMS reports pressure as 0.1 x raw in the car's pressure unit and temperature
      // as the car's degrees + 40 (car_vitals, MIT; a car set to psi / F showed 32 psi as 464 psi until this was read)
      "de.bmw.infotainment.vehicle.Vehicle": {
        statusNewCurrentUnitsStatusExt: (v) => {
          const press = unitName(
              PRESS_UNITS,
              v && v.unitOfMeasurementAirPressure,
            ),
            temp = unitName(TEMP_UNITS, v && v.unitOfMeasurementTemperature);
          if (press === this.carUnits.press && temp === this.carUnits.temp)
            return;
          this.carUnits.press = press;
          this.carUnits.temp = temp;
          this.log.info(
            "car units: pressure " +
              (press || "?") +
              ", temperature " +
              (temp || "?"),
          );
        },
      },
      // S / M next to the gear: the gearbox status carries no programme on some cars, the M drive display does
      "de.bmw.infotainment.misc.MDrive": {
        dataDisplayGearbox: (v) => {
          this.program = PROGRAMS[v && v.displayProgramGearbox] || null;
        },
      },
      // outside temperature: raw * 0.5 - 40 deg C, 255 = none (car_vitals, MIT)
      "de.bmw.infrastructure.EnvironmentalInformation": {
        ExteriorTemperature: (v) => {
          const t = v && v.temperatureExterior;
          this.ambient = isNum(t) && t !== 255 ? t * 0.5 - 40 : null;
        },
      },
      // what BMW's HUD draws for ACC / DCC / STA ("cruise" mode); only HUD apps with makeRoom list it in app.json
      "de.bmw.infotainment.displaydataserver.DisplayDataServer": {
        functionalLibraryData: (v) => this._onAssist(v),
      },
      // the car ahead (gap, its speed): notify only, so "s" in app.json; raw until calibrated (config.acc)
      "de.bmw.dass.GapVehicleAhead": {
        DataFrontVehicle: (v) => {
          if (!v) return;
          // 4093..4095 are "no object / not available" codes (with no car ahead an X3 sends 4093 in every field and
          // object id 253, Nov 8 2026), as 253..255 are for the object id
          /** @type {(x: *) => ?number} */
          const num = (x) => (isNum(x) && x < 4093 ? x : null);
          const id = v.frontVehicleObjectID,
            none = !isNum(id) || id >= 253;
          this.ahead = {
            gapX: none ? null : num(v.frontVehicleGapX),
            gapY: none ? null : num(v.frontVehicleGapY),
            speedX: none ? null : num(v.frontVehicleSpeedX),
            speedY: none ? null : num(v.frontVehicleSpeedY),
            q: v.qualifierEventDataFunctionFrontVehicle,
            at: Date.now(),
          };
          this._logAhead("front", v);
        },
        GapVehicleDrivingAhead: (v) => {
          if (!v) return;
          const g = v.gapVehicleDrivingAhead,
            m = enumNum(
              v.statusMeasurementVehicleDrivingAhead,
              AHEAD2_MEASURED,
            );
          this.ahead2 = {
            gap: isNum(g) && g < 253 ? g : null,
            q: v.qualifierFunctionVehicleDrivingAhead,
            measured: m >= 1 && m <= 4,
            at: Date.now(),
          };
          this._gapRate();
          this._logAhead("gap", v);
        },
      },
      // the accelerator pedal and the brake lights (config.pedals); notify only, so "s" in app.json
      "de.bmw.powertrain.AcceleratorPedal": {
        AngleAcceleratorPedal: (v) => {
          const raw = v && v.actualValueAngleAcceleratorPedal;
          const ok =
            enumNum(
              v && v.qualifierActualValueAngleAcceleratorPedal,
              PEDAL_OK,
            ) === 1;
          this.pedal = ok && isNum(raw) ? { raw, at: Date.now() } : null;
          // for working out config.pedal: every change, at most 5 a second, with the pedal message's other values (a
          // slow press on the car showed the bar jumping, Nov 7 2026: wrong field or scaling)
          const line =
            raw +
            " virtual " +
            (v && v.actualValueAngleAcceleratorPedalVirtual) +
            " gradient " +
            (v && v.gradientActualValueAngleAcceleratorPedal) +
            " (" +
            (v && v.qualifierActualValueAngleAcceleratorPedal) +
            ")";
          if (line !== this.pedalLine && Date.now() - this.pedalLogged > 200) {
            this.pedalLogged = Date.now();
            this.pedalLine = line;
            this.log.info("accelerator pedal raw " + line);
          }
        },
      },
      // the 12 V battery's charge condition (config.pedals, with the 12 V voltage)
      "de.bmw.infotainment.vehicle.CDS": {
        // the hand brake contact (a fallback for the parking brake lamp): 2 set, 1 released
        statusHandBrake: (v) => {
          const n = enumNum(v && v.statusContactHandBrake, HAND_BRAKE);
          this.parkBrakeCds = n === 2 ? true : n === 1 ? false : null;
        },
        statusBattery2: (v) => {
          const c = v && v.conditionBatteryChargingCondition;
          const raw = isNum(c) && c !== 255 ? c : null;
          if (raw !== this.battRaw)
            this.log.info("12 V battery charge condition raw " + c);
          this.battRaw = raw;
          this.battAt = Date.now();
        },
      },
      "de.bmw.body.Light": {
        LampExterior: (v) => {
          const b = enumNum(v && v.controlFunctionBrakeLight, BRAKE_LIGHT);
          this.brakeOn =
            b === BRAKE_LIGHT.ON_BL
              ? true
              : b === BRAKE_LIGHT.OFF_BL
                ? false
                : null;
        },
        // the indicators (the Regal theme's turn lamps): controlIndicateDirection 1 / 3 left, 2 / 4 right, 8 hazards
        StatusFunctionsIndicators: (v) => {
          const raw = v && v.controlIndicateDirection,
            d = enumNum(raw, INDICATE);
          const t =
            d === 1 || d === 3
              ? "L"
              : d === 2 || d === 4
                ? "R"
                : d === 8
                  ? "LR"
                  : d === 0
                    ? ""
                    : null;
          if (t !== this.turn)
            this.log.info(
              "indicators raw " +
                raw +
                (v && v.activeFunctionIndicateDirection !== undefined
                  ? " / " + v.activeFunctionIndicateDirection
                  : ""),
            );
          this.turn = t;
          this.turnAt = Date.now();
        },
      },
      // the parking brake (the Regal theme's left lamp): statusParkingBrake 1 / 4 = set or setting, 0 / 2 = released
      "de.bmw.infotainment.vehicle.Vehicle2": {
        statusStandstillFunctions: (v) => {
          const raw = v && v.statusParkingBrake,
            n = enumNum(raw, PARK_BRAKE);
          const on =
            n === 1 || n === 4 ? true : n === 0 || n === 2 ? false : null;
          if (on !== this.parkBrake)
            this.log.info("parking brake raw " + JSON.stringify(v));
          this.parkBrake = on;
        },
      },
      // Auto Hold (the same lamp, green): statusAutoH 2 = on and holding the car, 1 = on, 0 = off
      "de.bmw.chassis.VehicleStabilizationManagement": {
        StandStillFunction: (v) => {
          const raw = v && v.statusAutoH,
            n = enumNum(raw, AUTO_H);
          const h =
            n === 2 ? "hold" : n === 1 ? "armed" : n === 0 ? "off" : null;
          if (h !== this.autoHold)
            this.log.info(
              "auto hold raw " +
                raw +
                ", parking brake " +
                (v && v.statusParkingBrake),
            );
          this.autoHold = h;
          // this message carries the parking brake too, when Vehicle2 has not said
          const pb = enumNum(v && v.statusParkingBrake, PARK_BRAKE);
          if (
            this.parkBrake === null &&
            (pb === 0 || pb === 1 || pb === 2 || pb === 4)
          )
            this.parkBrakeVsm = pb === 1 || pb === 4;
        },
      },
      // the odometer (the Regal theme's VFD): MileageSupreme, unit unconfirmed (taken as km; logged raw on change)
      "de.bmw.infrastructure.MileageSupreme": {
        mileageSupreme: (v) => {
          const m = v && v.mileageSupreme;
          const km = isNum(m) && m > 0 && m < 0xffffff ? m : null;
          if (km !== this.mileage)
            this.log.info("odometer raw " + JSON.stringify(v));
          this.mileage = km;
        },
      },
      "de.bmw.infotainment.drivingexcitement.FES": {
        statusSwitchDriveDynamicSport2: (v) => {
          const raw = v && v.displayBoostPressure;
          if (typeof raw !== "number" || raw === BOOST_SCALE.invalid) return;
          this.boostFes = raw * BOOST_SCALE.factor + BOOST_SCALE.offset;
          this.boostFesAt = Date.now();
        },
        // the HMI's sport display: power and torque in % of the car's maximum (car_vitals, MIT); 255 = none
        statusVehicleDynamicEngine: (v) => {
          const p = v && v.displaySportEnginePower,
            t = v && v.displaySportEngineTorque;
          this.sportPower = isNum(p) && p >= 0 && p <= 150 ? p : null;
          this.sportTorque = isNum(t) && t >= 0 && t <= 150 ? t : null;
          this.sportAt = Date.now();
        },
        statusFESVehicleDynamicSwitchHMI: (v) => {
          const raw = v && v.actualValueModeDrivingExperience;
          const m = driveModeOf(raw),
            variant = m ? driveVariantOf(raw) : null;
          if (!m || (m === this.driveMode && variant === this.driveVariant))
            return;
          this.log.info(
            "drive mode " +
              MODE_NAME[m] +
              (variant ? " " + variant : "") +
              " (" +
              raw +
              ")",
          );
          this.driveMode = m;
          this.driveVariant = variant;
          if (this._layoutName() !== this.activeName) this._rebuild();
          else this._status();
        },
      },
    };
    // the HUD modes' signal only with them; the car ahead with them or app.json config.carAhead (the cluster's Sport)
    // (the runtime spec has no "signals": the interface must also be in app.json "signals")
    if (!this._modesOn() && this.config.lamps !== true)
      delete extra["de.bmw.infotainment.displaydataserver.DisplayDataServer"];
    if (this.config.lamps !== true) {
      delete extra["de.bmw.infrastructure.MileageSupreme"];
      delete extra["de.bmw.infotainment.vehicle.Vehicle2"];
      delete extra["de.bmw.chassis.VehicleStabilizationManagement"];
      if (extra["de.bmw.infotainment.vehicle.CDS"])
        delete extra["de.bmw.infotainment.vehicle.CDS"].statusHandBrake;
    }
    if (!this._modesOn() && this.config.carAhead !== true)
      delete extra["de.bmw.dass.GapVehicleAhead"];
    if (!this.config.consumption)
      delete extra["de.bmw.infotainment.resetlogic.ResetLogic"];
    if (this.config.pedals !== true) {
      delete extra["de.bmw.powertrain.AcceleratorPedal"];
      if (this.config.lamps === true)
        delete extra["de.bmw.infotainment.vehicle.CDS"].statusBattery2;
      else delete extra["de.bmw.infotainment.vehicle.CDS"];
    }
    if (this.config.pedals !== true && this.config.lamps !== true) {
      // the indicators alone (config.indicators: the Miku character points that way)
      if (this.config.indicators === true)
        delete extra["de.bmw.body.Light"].LampExterior;
      else delete extra["de.bmw.body.Light"];
    }
    this.car = new Car(
      this.ctx,
      ["rpm", "speed", "temps", "accel", "gear", "torque"],
      extra,
    );
    this.car.setRedline(this.setting("redline"));
    this.score = new ShiftScore(
      this.car,
      () => ({
        redline: this.setting("redline"),
        shiftBefore: this.setting("shiftBefore"),
        coldGuard: this.setting("coldGuard"),
      }),
      this.log,
    );
  },

  /**
   * Boost from the engine unit when the sport display's value isn't there (config.dme, read-only UDS).
   * @returns {void}
   */
  _startDme() {
    const dme = this.config.dme;
    if (
      !dme ||
      !["boost", "volt", "pedal"].some(
        (k) => Array.isArray(dme[k]) && dme[k].length,
      )
    )
      return;
    let rd = null,
      busy = false,
      baro = 101.3,
      baroAt = 0,
      boostAskAt = 0;
    try {
      const { Diag } = require("../kit/diag");
      const { DidReader } = require("../kit/dids");
      const link = new Diag(this.ctx.signals, this.log);
      link.quiet = true;
      Promise.resolve()
        .then(() => link.init())
        .catch((e) =>
          this.log.info(
            "engine unit link not available: " + ((e && e.message) || e),
          ),
        );
      rd = new DidReader(link, { ecu: dme.ecu || 18 });
    } catch (e) {
      this.log.info("engine unit boost off: " + ((e && e.message) || e));
      return;
    }
    this.dmeTimer = setInterval(
      () =>
        this._guard("engine unit boost", () => {
          const now = Date.now();
          if (busy || this.car.data().demo) return;
          // one question per tick, the pedal first (it moves the most), each only while a shown widget uses it
          const wantPedal =
            this.needsPedal &&
            Array.isArray(dme.pedal) &&
            now - this.pedalObdAt >= PEDAL_MS;
          const wantVolt =
            !wantPedal &&
            this.needsVolt &&
            Array.isArray(dme.volt) &&
            now - this.volt12At > VOLT_MS;
          const wantBoost =
            !wantPedal &&
            !wantVolt &&
            this.needsBoost &&
            Array.isArray(dme.boost) &&
            now - this.boostFesAt >= FRESH_MS &&
            now - boostAskAt >= 400;
          if (!wantPedal && !wantVolt && !wantBoost) return;
          busy = true;
          (async () => {
            if (wantPedal) {
              const v = await rd.value("pedal", dme.pedal);
              this.pedalObdAt = Date.now();
              this.pedalObd = isNum(v) ? v : null;
              if (
                isNum(v) &&
                Math.round(v) !== this.pedalObdLogged &&
                now - this.pedalLogged > 200
              ) {
                // for config.pedal.obdRange
                this.pedalObdLogged = Math.round(v);
                this.pedalLogged = now;
                this.log.info("accelerator pedal (OBD) " + v.toFixed(1) + " %");
              }
              return;
            }
            if (wantVolt) {
              const v = await rd.value("volt", dme.volt);
              this.volt12At = Date.now();
              this.volt12 = isNum(v) ? v : null;
              return;
            }
            boostAskAt = now;
            if (now - baroAt > 60000 && Array.isArray(dme.baro)) {
              baroAt = now;
              const b = await rd.value("baro", dme.baro);
              if (isNum(b)) baro = b;
            }
            const m = await rd.value("boost", dme.boost);
            if (isNum(m)) {
              this.boostDme = (m - baro) / 100;
              this.boostDmeAt = Date.now();
            }
          })()
            .catch((e) =>
              this.log.info("engine unit boost: " + ((e && e.message) || e)),
            )
            .then(() => {
              busy = false;
            });
        }),
      100,
    );
  },

  /**
   * BMW's route guidance on / off, for the HUD modes.
   * @returns {void}
   */
  _startNav() {
    if (!this._modesOn() && !this.ctx.settings.item("navLayout")) return;
    const h = {
      guidanceState: (v) => this._guard("guidance", () => this._onGuidance(v)),
    };
    if (this.ctx.settings.item("navLayout")) {
      // the route's progress (Sport's route bar): distance and time left to the final destination, distance travelled
      h.finalDestinationInfo = (v) =>
        this._guard("route", () => this._onRouteInfo(v));
      h.travelledDistance = (v) =>
        this._guard("route", () => this._onTravelled(v));
    }
    Promise.resolve()
      .then(() =>
        this.ctx.signals.watch(GUIDANCE.iface, GUIDANCE.instance, h, this.log),
      )
      .then((s) => {
        this.navSub = s;
        this.log.info(
          "signal Guidance " +
            (s && s.error ? "error: " + s.error : "subscribed"),
        );
      })
      .catch((e) =>
        this.log.info(
          "route guidance not available: " + ((e && e.message) || e),
        ),
      );
  },

  /**
   * The song title BMW's player shows (app.json config.music), for {{musicTitle}}.
   * @returns {void}
   */
  _startMedia() {
    if (!this.config.music) return;
    this.media = { pm: null, mm: null, tracks: null, sel: null };
    /** @type {(k: string) => (v: *) => void} */
    const on = (k) => (v) =>
      this._guard("media", () => {
        this.media[k] = v && typeof v === "object" ? v : null;
        this._pickTitle(k);
      });
    Promise.resolve()
      .then(() =>
        this.ctx.signals.watch(
          MEDIA.iface,
          MEDIA.instance,
          {
            playerMetadata: on("pm"),
            mainMenuMetadata: on("mm"),
            tracks: on("tracks"),
            trackSelection: on("sel"),
          },
          this.log,
        ),
      )
      .then((s) => {
        this.mediaSub = s;
        this.log.info(
          "signal HmiMediaState " +
            (s && s.error ? "error: " + s.error : "subscribed"),
        );
      })
      .catch((e) =>
        this.log.info(
          "media metadata not available: " + ((e && e.message) || e),
        ),
      );
    // load the font now, not on the first title's paint (the search walks folders once)
    this.fontT = setTimeout(
      () => this._guard("font", () => this._sysFont()),
      2000,
    );
  },

  /** The title, from HmiMediaState: playerMetadata's line typed TITLE; else (the car's player sends only ARTIST and
   *  ALBUM there, "Aimer" / "Sleepless Nights", Nov 9 2026) the playing track's entry in the track list (by trackId,
   *  its first line), or mainMenuMetadata's first line that isn't the artist or album; else an untyped playerMetadata
   *  line (the second first); else the artist. Each source's raw text is logged when it changes, to confirm on the car.
   * @param {string} changed the source that changed: pm, mm, tracks, sel
   * @returns {void}
   */
  _pickTitle(changed) {
    const m = this.media,
      pm = m.pm || {};
    /** @type {(x: *) => string} */
    const clean = (x) =>
      String(x || "")
        .replace(/\s+/g, " ")
        .trim();
    /** @type {(ty: *) => number} a MEDIA_ITEM */
    const kind = (ty) => {
      const n = enumNum(ty, MEDIA_ITEM);
      if (n >= 0 && n !== null) return n;
      const u = String(ty || "").toUpperCase();
      return /TITLE/.test(u)
        ? MEDIA_ITEM.TITLE
        : /ARTIST/.test(u)
          ? MEDIA_ITEM.ARTIST
          : /ALBUM/.test(u)
            ? MEDIA_ITEM.ALBUM
            : 0;
    };
    const lines = [
      [clean(pm.firstLineText), kind(pm.firstLineType)],
      [clean(pm.secondLineText), kind(pm.secondLineType)],
    ];
    const other = lines
      .filter(
        (l) =>
          l[0] && (l[1] === MEDIA_ITEM.ARTIST || l[1] === MEDIA_ITEM.ALBUM),
      )
      .map((l) => l[0]);
    /** @type {(x: string) => boolean | string} */
    const fresh = (x) => x && other.indexOf(x) < 0;
    // the raw sources, logged once per change
    const id =
      m.sel && m.sel.selectedTrackId !== undefined
        ? m.sel.selectedTrackId
        : pm.trackId;
    const list =
      m.tracks && Array.isArray(m.tracks.tracks) ? m.tracks.tracks : [];
    const tr =
      id !== undefined
        ? list.find((t) => t && String(t.trackId) === String(id))
        : null;
    const mm = m.mm
      ? [
          clean(m.mm.firstLineText),
          clean(m.mm.secondLineText),
          clean(m.mm.thirdLineText),
        ]
      : null;
    const raw = JSON.stringify({
      track: tr ? [clean(tr.firstLine), clean(tr.secondLine)] : null,
      id: id,
      of: list.length,
      menu: mm,
    });
    if (raw !== this.mediaRaw) {
      this.mediaRaw = raw;
      this.log.info("media sources (" + changed + "): " + raw);
    }
    let t = "",
      from = "";
    const typed = lines.find((l) => l[0] && l[1] === MEDIA_ITEM.TITLE);
    if (typed) {
      t = typed[0];
      from = "player TITLE";
    }
    if (!t && tr) {
      const c = [clean(tr.firstLine), clean(tr.secondLine)].find(fresh);
      if (c) {
        t = c;
        from = "track list";
      }
    }
    if (!t && mm) {
      const c = mm.find(fresh);
      if (c) {
        t = c;
        from = "main menu";
      }
    }
    if (!t) {
      const u = [lines[1], lines[0]].find(
        (l) => l[0] && l[1] !== MEDIA_ITEM.ARTIST && l[1] !== MEDIA_ITEM.ALBUM,
      );
      if (u) {
        t = u[0];
        from = "player line";
      }
    }
    if (!t) {
      t = lines[0][0];
      from = t ? "artist (no title anywhere)" : "nothing";
    }
    if (t !== this.musicTitle)
      this.log.info(
        "now playing " +
          JSON.stringify(t) +
          " from " +
          from +
          " (player lines " +
          JSON.stringify(lines) +
          ", uiType " +
          JSON.stringify(pm.uiType) +
          ")",
      );
    this.musicTitle = t;
  },

  /** KombiIF statusShowTimeDate: the cluster's displayed local time against UTC now, to the nearest 15 min within
   *  -12..+14 h, is the car's time zone. 255 = not sent.
   * @param {*} v
   * @returns {void}
   */
  _onCarClock(v) {
    const h = v && v.displayHour,
      m = v && v.displayMinute;
    if (!isNum(h) || !isNum(m) || h > 23 || m > 59) return;
    const now = new Date();
    let off = h * 60 + m - (now.getUTCHours() * 60 + now.getUTCMinutes());
    off = Math.round(off / 15) * 15;
    while (off < -12 * 60) off += 1440;
    while (off > 14 * 60) off -= 1440;
    if (off === this.carOffsetMin) return;
    this.carOffsetMin = off;
    this.log.info(
      "car clock " +
        h +
        ":" +
        pad2(m) +
        ": time zone UTC" +
        (off < 0 ? "-" : "+") +
        pad2(Math.floor(Math.abs(off) / 60)) +
        ":" +
        pad2(Math.abs(off) % 60),
    );
  },
};
