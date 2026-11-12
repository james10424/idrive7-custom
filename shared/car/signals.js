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

const BYTE_NONE = 255; // a byte signal's "none" (fuel, outside temperature, battery condition)
const RANGE_NONE = 4095; // KombiIF range: none
const MILEAGE_NONE = 0xffffff; // a 24-bit mileage: none
const CONS_NONE = 65535; // a consumption raw: none
const CONS_MAX_DIGITS = 3; // averageConsumption's decimal digits at most
const TPMS_POLL_MS = 10000; // the tyres are polled this often
const AMBIENT_SCALE = 0.5,
  AMBIENT_OFFSET_C = 40; // outside temperature: raw * 0.5 - 40
const AHEAD_NONE_MIN = 4093; // DataFrontVehicle: 4093..4095 are "no object / not available"
const AHEAD_ID_NONE_MIN = 253; // DataFrontVehicle object id: 253..255 are "no object"
const GAP2_NONE_MIN = 253; // GapVehicleDrivingAhead's gap: 253 and up, nothing measured
const PEDAL_LOG_MS = 200; // pedal readings: logged at most 5 times a second
const SPORT_PCT_MAX = 150; // the sport display's power / torque %: over this is none
const STD_BARO_KPA = 101.3; // outside air pressure until the engine unit has given one
const DME_ECU = 18; // config.dme.ecu when unset: the engine unit's address (0x12)
const BOOST_ASK_MS = 400; // the engine unit's boost: asked at most this often
const BARO_ASK_MS = 60000; // the engine unit's outside air pressure: asked at most this often
const DME_TICK_MS = 100; // the engine unit's question timer
const FONT_LOAD_MS = 2000; // the car's font: loaded this long after the media signals start
const TZ_STEP_MIN = 15; // time zones are whole quarter hours
const TZ_MIN_H = -12,
  TZ_MAX_H = 14; // the time zones there are, UTC-12..UTC+14

/** @typedef {import("./consts").Signals} Signals */

/**
 * HmiMediaState as last sent (_startMedia).
 * @typedef {object} MediaState
 * @property {?import("./someip").Fields["de.bmw.infotainment.hmi.hmimediastate.HmiMediaState"]["playerMetadata"]} pm
 * @property {?import("./someip").Fields["de.bmw.infotainment.hmi.hmimediastate.HmiMediaState"]["mainMenuMetadata"]} mm
 * @property {?import("./someip").Fields["de.bmw.infotainment.hmi.hmimediastate.HmiMediaState"]["tracks"]} tracks
 * @property {?import("./someip").Fields["de.bmw.infotainment.hmi.hmimediastate.HmiMediaState"]["trackSelection"]} sel
 */
/** @typedef {import("./consts").Ahead} Ahead */
/** @typedef {import("./consts").Ahead2} Ahead2 */
/**
 * The car's values on the app (App, through app_type.d.ts): set by _initCar (empty until the car sends them) and by the
 * signal handlers below.
 * @typedef {object} CarState
 * @property {?number} boostFes bar, from the sport display signal
 * @property {number} boostFesAt
 * @property {?number} boostDme bar, from the engine unit (fallback)
 * @property {number} boostDmeAt
 * @property {boolean} needsBoost a shown widget uses boost (the engine unit is only asked then)
 * @property {?string} driveMode 'comfort' | 'sport' | 'eco', once the car has said
 * @property {?string} driveVariant 'plus' (Sport+ / Comfort+ / Eco Pro+), 'individual', or null
 * @property {boolean} navActive BMW's route guidance is on (the HUD shows its own guidance then)
 * @property {unknown} navRaw the last guidanceState as the car sent it, for the log
 * @property {boolean} assistActive BMW's HUD shows its driver assistance block (ACC, DCC, STA)
 * @property {string | undefined} assistRaw the last summary of it, for the log
 * @property {?Ahead} ahead the car ahead, raw (DataFrontVehicle)
 * @property {?Ahead2} ahead2 GapVehicleDrivingAhead
 * @property {?{ v: ?number, gapM: number, at: number }} relFromGap km/h, the gap's smoothed rate of change
 * @property {?{ raw: number, at: number }} pedal the accelerator pedal as sent, while valid
 * @property {string} [pedalLine] its last logged message
 * @property {?boolean} brakeOn the brake lights, null until the car says
 * @property {?string} turn the indicators: 'L', 'R', 'LR' (hazards) or '' (body.Light StatusFunctionsIndicators)
 * @property {number} [turnAt] when they last changed
 * @property {boolean} accOn BMW's HUD has the ACC car or distance bars up (the Grand National CRUISE lamp)
 * @property {?number} mileage the odometer as sent (MileageSupreme, taken as km)
 * @property {?boolean} parkBrake the parking brake set, null until the car says
 * @property {?boolean} parkBrakeCds the same from CDS statusHandBrake (a fallback)
 * @property {?boolean} [parkBrakeVsm] the same from VehicleStabilizationManagement
 * @property {?string} autoHold Auto Hold: 'hold' (holding the car), 'armed', 'off', null until the car says
 * @property {?number} volt12 V, the 12 V system from the engine unit
 * @property {number} volt12At
 * @property {boolean} needsVolt a shown widget uses volt12 (the engine unit is only asked then)
 * @property {number} pedalLogged
 * @property {?number} pedalObd %, the pedal from the engine unit (OBD PID 0x49)
 * @property {number} pedalObdAt
 * @property {?number} pedalObdLogged
 * @property {boolean} needsPedal a shown widget uses the throttle (the engine unit is only asked then)
 * @property {?number} decelF g, the smoothed deceleration for the brake bar
 * @property {number} decelAt
 * @property {?number} carOffsetMin the car's time zone, minutes from UTC, from the time the cluster shows
 * @property {?number} battRaw the 12 V battery's charge condition as sent
 * @property {number} battAt
 * @property {Record<string, string>} aheadLogged the car-ahead messages last logged, by kind
 * @property {?number} accSetRaw cruiseCtrlSpeedHUD as sent
 * @property {Record<string, number>} aheadLogAt
 * @property {{ press: ?string, temp: ?string, psiSeen: boolean }} carUnits the car's display units, for the TPMS values
 * @property {?string} program 'S' / 'M' from the MDrive gearbox display, else null (D)
 * @property {?number} fuelL KombiIF tank, litres
 * @property {?number} rangeKm KombiIF range
 * @property {?number} ambient outside temperature, C
 * @property {?number} odoKm KombiIF odometer (whole km)
 * @property {number} odoAcc the distance since its last km
 * @property {number} odoAt
 * @property {{ p: Record<string, ?number>, t: Record<string, ?number> }} tyres TPMS pressure (bar) and temperature (C) per corner FL FR RL RR
 * @property {?number} [consAvg] ResetLogic's average consumption, scaled
 * @property {?number} [consUnit] its unit (CONS_UNIT)
 * @property {number} [consAt]
 * @property {unknown} [consPeriod] the trip computer period picked on the center screen
 * @property {?number} [consBc] the on-board computer's average
 * @property {?number} [consUnitBc]
 * @property {number} [consBcAt]
 * @property {?number} [sportPower] the sport display's power, %
 * @property {?number} [sportTorque] its torque, %
 * @property {number} [sportAt]
 * @property {import("../shift_score").Car} car the kit's Car with the extra signals (its data() a snapshot per tick)
 * @property {import("../shift_score")} score the shift scorer
 * @property {() => void} _freshData takes a new snapshot of the car's data (once a tick)
 * @property {ReturnType<typeof setInterval>} [dmeTimer] the engine unit reads
 * @property {MediaState} [media]
 * @property {string} [mediaRaw]
 * @property {import("../engine/app").Subscription} [mediaSub]
 * @property {import("../engine/app").Subscription} [navSub]
 * @property {string} [musicTitle]
 * @property {ReturnType<typeof setTimeout>} [fontT]
 */

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /**
   * The car's values, empty until the car sends them.
   * @returns {void}
   */
  _initCar() {
    this.boostFes = null;
    this.boostFesAt = 0; // bar, from the sport display signal
    this.boostDme = null;
    this.boostDmeAt = 0; // bar, from the engine unit (fallback)
    this.needsBoost = false; // a shown widget uses boost (the engine unit is only asked then)
    this.driveMode = null; // 'comfort' | 'sport' | 'eco', once the car has said
    this.driveVariant = null; // 'plus' (Sport+ / Comfort+ / Eco Pro+), 'individual', or null
    this.navActive = false; // BMW's route guidance is on (the HUD shows its own guidance then)
    this.navRaw = undefined; // the last guidanceState as the car sent it, for the log
    this.assistActive = false; // BMW's HUD shows its driver assistance block (ACC, DCC, STA)
    this.assistRaw = undefined; // the last summary of it, for the log
    this.ahead = null; // the car ahead, raw: { gapX, gapY, speedX, speedY, q, at } (DataFrontVehicle)
    this.ahead2 = null; // { gap, q, measured, at } (GapVehicleDrivingAhead)
    this.relFromGap = null; // km/h, the gap's smoothed rate of change ({ v, gapM, at })
    this.pedal = null; // { raw, at }: the accelerator pedal as sent, while valid
    this.brakeOn = null; // the brake lights (true / false), null until the car says
    this.turn = null; // the indicators: 'L', 'R', 'LR' (hazards) or '' (body.Light StatusFunctionsIndicators)
    this.accOn = false; // BMW's HUD has the ACC car or distance bars up (the Grand National CRUISE lamp)
    this.mileage = null; // the odometer as sent (MileageSupreme, taken as km)
    this.parkBrake = null; // the parking brake set (true / false), null until the car says
    this.parkBrakeCds = null; // the same from CDS statusHandBrake (a fallback)
    this.autoHold = null; // Auto Hold: 'hold' (holding the car), 'armed', 'off', null until the car says
    this.volt12 = null;
    this.volt12At = 0; // V, the 12 V system from the engine unit
    this.needsVolt = false; // a shown widget uses volt12 (the engine unit is only asked then)
    this.pedalLogged = 0;
    this.pedalObd = null;
    this.pedalObdAt = 0;
    this.pedalObdLogged = null; // %, the pedal from the engine unit (OBD PID 0x49)
    this.needsPedal = false; // a shown widget uses the throttle (the engine unit is only asked then)
    this.decelF = null;
    this.decelAt = 0; // g, the smoothed deceleration for the brake bar
    this.carOffsetMin = null; // the car's time zone, minutes from UTC, from the time the cluster shows
    this.battRaw = null;
    this.battAt = 0; // the 12 V battery's charge condition as sent
    this.aheadLogged = {};
    this.accSetRaw = null; // cruiseCtrlSpeedHUD as sent
    this.aheadLogAt = {};
    this.carUnits = { press: null, temp: null, psiSeen: false }; // the car's display units, for the TPMS values
    this.program = null; // 'S' / 'M' from the MDrive gearbox display, else null (D)
    this.fuelL = null;
    this.rangeKm = null;
    this.ambient = null; // KombiIF tank / range, outside temperature
    this.odoKm = null;
    this.odoAcc = 0;
    this.odoAt = 0; // KombiIF odometer (whole km) and the distance since its last km
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
        statusShowTimeDate: (msg) => this._onCarClock(msg),
        statusRangeTankStatus: (msg) => {
          const fuel = msg && msg.fluidLevelFuelTank,
            range = msg && msg.range;
          this.fuelL = isNum(fuel) && fuel >= 0 && fuel < BYTE_NONE ? fuel : null;
          this.rangeKm =
            isNum(range) && range >= 0 && range < RANGE_NONE ? range : null;
          // the odometer, whole km (cauliflowermossgrape's Live Data reads it here; MileageSupreme never came)
          const mileage = msg && msg.mileageKilometre;
          const km =
            isNum(mileage) && mileage > 0 && mileage < MILEAGE_NONE
              ? mileage
              : null;
          if (km !== this.odoKm) {
            this.odoKm = km;
            this.odoAcc = 0;
          }
        },
      },
      // the trip computer for the period picked on the center screen (this trip, since refuelling, individual, long term):
      // average consumption (app.json config.consumption); raw values logged on change to check the scaling
      "de.bmw.infotainment.resetlogic.ResetLogic": {
        averageConsumption: (msg) => {
          if (!msg) return;
          const scaled = msg.consumptionCombustionCurrentScale,
            decimals = msg.consumptionCombustionCurrentDigit;
          this.consAvg =
            isNum(scaled) &&
            scaled < CONS_NONE &&
            isNum(decimals) &&
            decimals >= 0 &&
            decimals <= CONS_MAX_DIGITS
              ? scaled / Math.pow(10, decimals)
              : null;
          this.consUnit = enumNum(msg.combustionUnit, CONS_UNIT);
          this.consAt = Date.now();
          this._logCons("average", msg);
        },
        bcDataAll: (msg) => {
          if (!msg) return;
          const bc = msg.bcData || {};
          this.consPeriod =
            bc.resetOption !== undefined
              ? bc.resetOption
              : msg.activeResetLogic;
          this.consBc =
            isNum(bc.consumptionAverage) && bc.consumptionAverage < CONS_NONE
              ? bc.consumptionAverage
              : null;
          if (msg.bcUnits && msg.bcUnits.consumption !== undefined)
            this.consUnitBc = enumNum(msg.bcUnits.consumption, CONS_UNIT);
          this.consBcAt = Date.now();
          this._logCons("bc", {
            period: this.consPeriod,
            active: msg.activeResetLogic,
            avg: bc.consumptionAverage,
            now: bc.currentConsumption,
            speed: bc.speedAverage,
            units: msg.bcUnits,
          });
        },
      },
      // tyre pressure and temperature per corner, in the car's own display units (_tyreBar / _tyreC).
      // The car never notifies these (BMW's own x_call only ever reads them), so they are polled.
      "de.bmw.infotainment.vehicle.TPMS": {
        $pollMs: TPMS_POLL_MS,
        statusTyrePressure: (msg) =>
          TYRE_CORNERS.forEach((k) => {
            this.tyres.p[k] = this._tyreBar(
              msg && msg["actualValuePressureTyre" + k + "H"],
            );
          }),
        statusTyreTemperature: (msg) =>
          TYRE_CORNERS.forEach((k) => {
            this.tyres.t[k] = this._tyreC(
              msg && msg["actualValueTemperatureTyre" + k + "H"],
            );
          }),
      },
      // the car's display units: the TPMS reports pressure as 0.1 x raw in the car's pressure unit and temperature
      // as the car's degrees + 40 (car_vitals, MIT; a car set to psi / F showed 32 psi as 464 psi until this was read)
      "de.bmw.infotainment.vehicle.Vehicle": {
        statusNewCurrentUnitsStatusExt: (msg) => {
          const press = unitName(
              PRESS_UNITS,
              msg && msg.unitOfMeasurementAirPressure,
            ),
            temp = unitName(
              TEMP_UNITS,
              msg && msg.unitOfMeasurementTemperature,
            );
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
        dataDisplayGearbox: (msg) => {
          this.program = PROGRAMS[msg && msg.displayProgramGearbox] || null;
        },
      },
      // outside temperature: raw * 0.5 - 40 deg C, 255 = none (car_vitals, MIT)
      "de.bmw.infrastructure.EnvironmentalInformation": {
        ExteriorTemperature: (msg) => {
          const raw = msg && msg.temperatureExterior;
          this.ambient = isNum(raw) && raw !== BYTE_NONE
              ? raw * AMBIENT_SCALE - AMBIENT_OFFSET_C
              : null;
        },
      },
      // what BMW's HUD draws for ACC / DCC / STA ("cruise" mode); only HUD apps with makeRoom list it in app.json
      "de.bmw.infotainment.displaydataserver.DisplayDataServer": {
        functionalLibraryData: (msg) => this._onAssist(msg),
      },
      // the car ahead (gap, its speed): notify only, so "s" in app.json; raw until calibrated (config.acc)
      "de.bmw.dass.GapVehicleAhead": {
        DataFrontVehicle: (msg) => {
          if (!msg) return;
          // 4093..4095 are "no object / not available" codes (with no car ahead an X3 sends 4093 in every field and
          // object id 253, Nov 8 2026), as 253..255 are for the object id
          /** @type {(value: *) => ?number} */
          const num = (value) => (isNum(value) && value < AHEAD_NONE_MIN ? value : null);
          const id = msg.frontVehicleObjectID,
            none = !isNum(id) || id >= AHEAD_ID_NONE_MIN;
          this.ahead = {
            gapX: none ? null : num(msg.frontVehicleGapX),
            gapY: none ? null : num(msg.frontVehicleGapY),
            speedX: none ? null : num(msg.frontVehicleSpeedX),
            speedY: none ? null : num(msg.frontVehicleSpeedY),
            q: msg.qualifierEventDataFunctionFrontVehicle,
            at: Date.now(),
          };
          this._logAhead("front", msg);
        },
        GapVehicleDrivingAhead: (msg) => {
          if (!msg) return;
          const gap = msg.gapVehicleDrivingAhead,
            measurement = enumNum(
              msg.statusMeasurementVehicleDrivingAhead,
              AHEAD2_MEASURED,
            );
          this.ahead2 = {
            gap: isNum(gap) && gap < GAP2_NONE_MIN ? gap : null,
            q: msg.qualifierFunctionVehicleDrivingAhead,
            measured:
              measurement >= AHEAD2_MEASURED.NEUES_ELEMENT__GEMESSEN &&
              measurement <= AHEAD2_MEASURED.ELEMENT_PRAEDIZIERT,
            at: Date.now(),
          };
          this._gapRate();
          this._logAhead("gap", msg);
        },
      },
      // the accelerator pedal and the brake lights (config.pedals); notify only, so "s" in app.json
      "de.bmw.powertrain.AcceleratorPedal": {
        AngleAcceleratorPedal: (msg) => {
          const raw = msg && msg.actualValueAngleAcceleratorPedal;
          const valid =
            enumNum(
              msg && msg.qualifierActualValueAngleAcceleratorPedal,
              PEDAL_OK,
            ) ===
            PEDAL_OK.SIGNALWERT_IST_GUELTIG_UND_ABGESICHERT_UND_PLAUSIBILISIERT;
          this.pedal = valid && isNum(raw) ? { raw, at: Date.now() } : null;
          // for working out config.pedal: every change, at most 5 a second, with the pedal message's other values (a
          // slow press on the car showed the bar jumping, Nov 7 2026: wrong field or scaling)
          const line =
            raw +
            " virtual " +
            (msg && msg.actualValueAngleAcceleratorPedalVirtual) +
            " gradient " +
            (msg && msg.gradientActualValueAngleAcceleratorPedal) +
            " (" +
            (msg && msg.qualifierActualValueAngleAcceleratorPedal) +
            ")";
          if (line !== this.pedalLine && Date.now() - this.pedalLogged > PEDAL_LOG_MS) {
            this.pedalLogged = Date.now();
            this.pedalLine = line;
            this.log.info("accelerator pedal raw " + line);
          }
        },
      },
      // the 12 V battery's charge condition (config.pedals, with the 12 V voltage)
      "de.bmw.infotainment.vehicle.CDS": {
        // the hand brake contact (a fallback for the parking brake lamp): 2 set, 1 released
        statusHandBrake: (msg) => {
          const contact = enumNum(
            msg && msg.statusContactHandBrake,
            HAND_BRAKE,
          );
          this.parkBrakeCds =
            contact === HAND_BRAKE.HANDBREMSE_ANGEZOGEN
              ? true
              : contact === HAND_BRAKE.HANDBREMSE_GELOEST
                ? false
                : null;
        },
        statusBattery2: (msg) => {
          const condition = msg && msg.conditionBatteryChargingCondition;
          const raw = isNum(condition) && condition !== BYTE_NONE ? condition : null;
          if (raw !== this.battRaw)
            this.log.info("12 V battery charge condition raw " + condition);
          this.battRaw = raw;
          this.battAt = Date.now();
        },
      },
      "de.bmw.body.Light": {
        LampExterior: (msg) => {
          const brakeLight = enumNum(
            msg && msg.controlFunctionBrakeLight,
            BRAKE_LIGHT,
          );
          this.brakeOn =
            brakeLight === BRAKE_LIGHT.ON_BL
              ? true
              : brakeLight === BRAKE_LIGHT.OFF_BL
                ? false
                : null;
        },
        // the indicators (the Grand National theme's turn lamps): controlIndicateDirection 1 / 3 left, 2 / 4 right, 8 hazards
        StatusFunctionsIndicators: (msg) => {
          const raw = msg && msg.controlIndicateDirection,
            direction = enumNum(raw, INDICATE);
          const turn =
            direction === INDICATE.TIPP_BLINKEN_LINKS_EIN ||
            direction === INDICATE.DAUER_BLINKEN_LINKS_EIN
              ? "L"
              : direction === INDICATE.TIPP_BLINKEN_RECHTS_EIN ||
                  direction === INDICATE.DAUER_BLINKEN_RECHTS_EIN
                ? "R"
                : direction === INDICATE.BEIDSEITIGES_BLINKEN_EIN
                  ? "LR"
                  : direction === INDICATE.BLINKEN_AUS
                    ? ""
                    : null;
          if (turn !== this.turn)
            this.log.info(
              "indicators raw " +
                raw +
                (msg && msg.activeFunctionIndicateDirection !== undefined
                  ? " / " + msg.activeFunctionIndicateDirection
                  : ""),
            );
          this.turn = turn;
          this.turnAt = Date.now();
        },
      },
      // the parking brake (the Grand National theme's left lamp): statusParkingBrake 1 / 4 = set or setting, 0 / 2 = released
      "de.bmw.infotainment.vehicle.Vehicle2": {
        statusStandstillFunctions: (msg) => {
          const raw = msg && msg.statusParkingBrake,
            status = enumNum(raw, PARK_BRAKE);
          const engaged =
            status === PARK_BRAKE.PARKBREMSE_MECHANISCH_FESTGESTELLT ||
            status === PARK_BRAKE.PARKBREMSE_IM_STELLVORGANG_FESTSTELLEN
              ? true
              : status === PARK_BRAKE.PARKBREMSE_MECHANISCH_NICHT_FESTGESTELLT ||
                  status === PARK_BRAKE.PARKBREMSE_IM_STELLVORGANG_LOESEN
                ? false
                : null;
          if (engaged !== this.parkBrake)
            this.log.info("parking brake raw " + JSON.stringify(msg));
          this.parkBrake = engaged;
        },
      },
      // Auto Hold (the same lamp, green): statusAutoH 2 = on and holding the car, 1 = on, 0 = off
      "de.bmw.chassis.VehicleStabilizationManagement": {
        StandStillFunction: (msg) => {
          const raw = msg && msg.statusAutoH,
            status = enumNum(raw, AUTO_H);
          const autoHold =
            status === AUTO_H.AUTOH_AKTIVIERT_UND_HAELT_FAHRZEUG
              ? "hold"
              : status === AUTO_H.AUTOH_AKTIVIERT_UND_HAELT_FAHRZEUG_NICHT
                ? "armed"
                : status === AUTO_H.AUTOH_NICHT_AKTIVIERT
                  ? "off"
                  : null;
          if (autoHold !== this.autoHold)
            this.log.info(
              "auto hold raw " +
                raw +
                ", parking brake " +
                (msg && msg.statusParkingBrake),
            );
          this.autoHold = autoHold;
          // this message carries the parking brake too, when Vehicle2 has not said
          const parkBrake = enumNum(msg && msg.statusParkingBrake, PARK_BRAKE);
          if (
            this.parkBrake === null &&
            (parkBrake === PARK_BRAKE.PARKBREMSE_MECHANISCH_NICHT_FESTGESTELLT ||
              parkBrake === PARK_BRAKE.PARKBREMSE_MECHANISCH_FESTGESTELLT ||
              parkBrake === PARK_BRAKE.PARKBREMSE_IM_STELLVORGANG_LOESEN ||
              parkBrake === PARK_BRAKE.PARKBREMSE_IM_STELLVORGANG_FESTSTELLEN)
          )
            this.parkBrakeVsm =
              parkBrake === PARK_BRAKE.PARKBREMSE_MECHANISCH_FESTGESTELLT ||
              parkBrake === PARK_BRAKE.PARKBREMSE_IM_STELLVORGANG_FESTSTELLEN;
        },
      },
      // the odometer (the Grand National theme's VFD): MileageSupreme, unit unconfirmed (taken as km; logged raw on change)
      "de.bmw.infrastructure.MileageSupreme": {
        mileageSupreme: (msg) => {
          const mileage = msg && msg.mileageSupreme;
          const km =
            isNum(mileage) && mileage > 0 && mileage < MILEAGE_NONE
              ? mileage
              : null;
          if (km !== this.mileage)
            this.log.info("odometer raw " + JSON.stringify(msg));
          this.mileage = km;
        },
      },
      "de.bmw.infotainment.drivingexcitement.FES": {
        statusSwitchDriveDynamicSport2: (msg) => {
          const raw = msg && msg.displayBoostPressure;
          if (typeof raw !== "number" || raw === BOOST_SCALE.invalid) return;
          this.boostFes = raw * BOOST_SCALE.factor + BOOST_SCALE.offset;
          this.boostFesAt = Date.now();
        },
        // the HMI's sport display: power and torque in % of the car's maximum (car_vitals, MIT); 255 = none
        statusVehicleDynamicEngine: (msg) => {
          const power = msg && msg.displaySportEnginePower,
            torque = msg && msg.displaySportEngineTorque;
          this.sportPower =
            isNum(power) && power >= 0 && power <= SPORT_PCT_MAX ? power : null;
          this.sportTorque =
            isNum(torque) && torque >= 0 && torque <= SPORT_PCT_MAX ? torque : null;
          this.sportAt = Date.now();
        },
        statusFESVehicleDynamicSwitchHMI: (msg) => {
          const raw = msg && msg.actualValueModeDrivingExperience;
          const mode = driveModeOf(raw),
            variant = mode ? driveVariantOf(raw) : null;
          if (
            !mode ||
            (mode === this.driveMode && variant === this.driveVariant)
          )
            return;
          this.log.info(
            "drive mode " +
              MODE_NAME[mode] +
              (variant ? " " + variant : "") +
              " (" +
              raw +
              ")",
          );
          this.driveMode = mode;
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
    // one copy of the car's values per tick: data() copies them every call, and a tick asks 20 to 40 times
    // (_freshData() at the start of each tick and of the Miku character's timer; up to one tick old in between)
    const carData = this.car.data.bind(this.car);
    /** @type {?import("../shift_score").CarData} */
    let snapshot = null;
    this.car.data = () => snapshot || (snapshot = carData());
    this._freshData = () => {
      snapshot = null;
    };
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
    let reader = null,
      busy = false,
      baro = STD_BARO_KPA,
      baroAt = 0,
      boostAskAt = 0;
    try {
      const { Diag } = require("../kit/diag");
      const { DidReader } = require("../kit/dids");
      const link = new Diag(this.ctx.signals, this.log);
      link.quiet = true;
      Promise.resolve()
        .then(() => link.init())
        .catch((err) =>
          this.log.info(
            "engine unit link not available: " + ((err && err.message) || err),
          ),
        );
      reader = new DidReader(link, { ecu: dme.ecu || DME_ECU });
    } catch (err) {
      this.log.info("engine unit boost off: " + ((err && err.message) || err));
      return;
    }
    this.dmeTimer = setInterval(
      () =>
        this._guard("engine unit boost", () => {
          const now = Date.now();
          if (busy || this._offScreen()) return;
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
            now - boostAskAt >= BOOST_ASK_MS;
          if (!wantPedal && !wantVolt && !wantBoost) return;
          if (this.car.data().demo) return;
          busy = true;
          (async () => {
            if (wantPedal) {
              const pedal = await reader.value("pedal", dme.pedal);
              this.pedalObdAt = Date.now();
              this.pedalObd = isNum(pedal) ? pedal : null;
              if (
                isNum(pedal) &&
                Math.round(pedal) !== this.pedalObdLogged &&
                now - this.pedalLogged > PEDAL_LOG_MS
              ) {
                // for config.pedal.obdRange
                this.pedalObdLogged = Math.round(pedal);
                this.pedalLogged = now;
                this.log.info(
                  "accelerator pedal (OBD) " + pedal.toFixed(1) + " %",
                );
              }
              return;
            }
            if (wantVolt) {
              const volt = await reader.value("volt", dme.volt);
              this.volt12At = Date.now();
              this.volt12 = isNum(volt) ? volt : null;
              return;
            }
            boostAskAt = now;
            if (now - baroAt > BARO_ASK_MS && Array.isArray(dme.baro)) {
              baroAt = now;
              const baroNow = await reader.value("baro", dme.baro);
              if (isNum(baroNow)) baro = baroNow;
            }
            const manifold = await reader.value("boost", dme.boost);
            if (isNum(manifold)) {
              this.boostDme = (manifold - baro) / 100;
              this.boostDmeAt = Date.now();
            }
          })()
            .catch((err) =>
              this.log.info(
                "engine unit boost: " + ((err && err.message) || err),
              ),
            )
            .then(() => {
              busy = false;
            });
        }),
      DME_TICK_MS,
    );
  },

  /**
   * BMW's route guidance on / off, for the HUD modes.
   * @returns {void}
   */
  _startNav() {
    if (!this._modesOn() && !this.ctx.settings.item("navLayout")) return;
    /** @type {import("./someip").HandlersOf<"de.bmw.infotainment.navigation.guiding.Guidance">} */
    const handlers = {
      guidanceState: (msg) =>
        this._guard("guidance", () => this._onGuidance(msg)),
    };
    if (this.ctx.settings.item("navLayout")) {
      // the route's progress (Sport's route bar): distance and time left to the final destination, distance travelled
      handlers.finalDestinationInfo = (msg) =>
        this._guard("route", () => this._onRouteInfo(msg));
      handlers.travelledDistance = (msg) =>
        this._guard("route", () => this._onTravelled(msg));
    }
    Promise.resolve()
      .then(() =>
        this.ctx.signals.watch(
          GUIDANCE.iface,
          GUIDANCE.instance,
          handlers,
          this.log,
        ),
      )
      .then((sub) => {
        this.navSub = sub;
        this.log.info(
          "signal Guidance " +
            (sub && sub.error ? "error: " + sub.error : "subscribed"),
        );
      })
      .catch((err) =>
        this.log.info(
          "route guidance not available: " + ((err && err.message) || err),
        ),
      );
  },

  /**
   * The song title BMW's player shows (app.json config.music), for {{musicTitle}}.
   * @returns {void}
   */
  _startMedia() {
    if (!this.config.music) return;
    /** @type {MediaState} */
    this.media = { pm: null, mm: null, tracks: null, sel: null };
    /** @type {(k: keyof MediaState) => (msg: MediaState[keyof MediaState]) => void} */
    const handler = (k) => (msg) =>
      this._guard("media", () => {
        this.media[k] = msg && typeof msg === "object" ? msg : null;
        this._pickTitle(k);
      });
    Promise.resolve()
      .then(() =>
        this.ctx.signals.watch(
          MEDIA.iface,
          MEDIA.instance,
          {
            playerMetadata: handler("pm"),
            mainMenuMetadata: handler("mm"),
            tracks: handler("tracks"),
            trackSelection: handler("sel"),
          },
          this.log,
        ),
      )
      .then((sub) => {
        this.mediaSub = sub;
        this.log.info(
          "signal HmiMediaState " +
            (sub && sub.error ? "error: " + sub.error : "subscribed"),
        );
      })
      .catch((err) =>
        this.log.info(
          "media metadata not available: " + ((err && err.message) || err),
        ),
      );
    // load the font now, not on the first title's paint (the search walks folders once)
    this.fontT = setTimeout(
      () => this._guard("font", () => this._sysFont()),
      FONT_LOAD_MS,
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
    const media = this.media,
      player = media.pm || {};
    /** @type {(text: unknown) => string} */
    const clean = (text) =>
      String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    /** @type {(type: unknown) => number} a MEDIA_ITEM */
    const kind = (type) => {
      const item = enumNum(type, MEDIA_ITEM);
      if (item >= 0 && item !== null) return item;
      const name = String(type || "").toUpperCase();
      return /TITLE/.test(name)
        ? MEDIA_ITEM.TITLE
        : /ARTIST/.test(name)
          ? MEDIA_ITEM.ARTIST
          : /ALBUM/.test(name)
            ? MEDIA_ITEM.ALBUM
            : MEDIA_ITEM.UNDEFINED;
    };
    /** @type {Array<[string, number]>} [text, MEDIA_ITEM] */
    const lines = [
      [clean(player.firstLineText), kind(player.firstLineType)],
      [clean(player.secondLineText), kind(player.secondLineType)],
    ];
    const other = lines
      .filter(
        (line) =>
          line[0] &&
          (line[1] === MEDIA_ITEM.ARTIST || line[1] === MEDIA_ITEM.ALBUM),
      )
      .map((line) => line[0]);
    /** @type {(text: string) => boolean | string} */
    const fresh = (text) => text && other.indexOf(text) < 0;
    // the raw sources, logged once per change
    const trackId =
      media.sel && media.sel.selectedTrackId !== undefined
        ? media.sel.selectedTrackId
        : player.trackId;
    const list =
      media.tracks && Array.isArray(media.tracks.tracks)
        ? media.tracks.tracks
        : [];
    const track =
      trackId !== undefined
        ? list.find(
            (entry) => entry && String(entry.trackId) === String(trackId),
          )
        : null;
    const menu = media.mm
      ? [
          clean(media.mm.firstLineText),
          clean(media.mm.secondLineText),
          clean(media.mm.thirdLineText),
        ]
      : null;
    const raw = JSON.stringify({
      track: track ? [clean(track.firstLine), clean(track.secondLine)] : null,
      id: trackId,
      of: list.length,
      menu: menu,
    });
    if (raw !== this.mediaRaw) {
      this.mediaRaw = raw;
      this.log.info("media sources (" + changed + "): " + raw);
    }
    let title = "",
      from = "";
    const typed = lines.find((line) => line[0] && line[1] === MEDIA_ITEM.TITLE);
    if (typed) {
      title = typed[0];
      from = "player TITLE";
    }
    if (!title && track) {
      const found = [clean(track.firstLine), clean(track.secondLine)].find(
        fresh,
      );
      if (found) {
        title = found;
        from = "track list";
      }
    }
    if (!title && menu) {
      const found = menu.find(fresh);
      if (found) {
        title = found;
        from = "main menu";
      }
    }
    if (!title) {
      const untyped = [lines[1], lines[0]].find(
        (line) =>
          line[0] &&
          line[1] !== MEDIA_ITEM.ARTIST &&
          line[1] !== MEDIA_ITEM.ALBUM,
      );
      if (untyped) {
        title = untyped[0];
        from = "player line";
      }
    }
    if (!title) {
      title = lines[0][0];
      from = title ? "artist (no title anywhere)" : "nothing";
    }
    if (title !== this.musicTitle)
      this.log.info(
        "now playing " +
          JSON.stringify(title) +
          " from " +
          from +
          " (player lines " +
          JSON.stringify(lines) +
          ", uiType " +
          JSON.stringify(player.uiType) +
          ")",
      );
    this.musicTitle = title;
  },

  /** KombiIF statusShowTimeDate: the cluster's displayed local time against UTC now, to the nearest 15 min within
   *  -12..+14 h, is the car's time zone. 255 = not sent.
   * @param {import("./someip").Fields["de.bmw.infotainment.KombiIF"]["statusShowTimeDate"]} msg
   * @returns {void}
   */
  _onCarClock(msg) {
    const hour = msg && msg.displayHour,
      minute = msg && msg.displayMinute;
    if (!isNum(hour) || !isNum(minute) || hour > 23 || minute > 59) return;
    const now = new Date();
    let off =
      hour * 60 + minute - (now.getUTCHours() * 60 + now.getUTCMinutes());
    off = Math.round(off / TZ_STEP_MIN) * TZ_STEP_MIN;
    while (off < TZ_MIN_H * 60) off += 1440;
    while (off > TZ_MAX_H * 60) off -= 1440;
    if (off === this.carOffsetMin) return;
    this.carOffsetMin = off;
    this.log.info(
      "car clock " +
        hour +
        ":" +
        pad2(minute) +
        ": time zone UTC" +
        (off < 0 ? "-" : "+") +
        pad2(Math.floor(Math.abs(off) / 60)) +
        ":" +
        pad2(Math.abs(off) % 60),
    );
  },
});
