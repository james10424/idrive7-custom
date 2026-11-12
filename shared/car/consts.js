"use strict";
/**
 * The car's enums and tables (the SOME/IP catalog, someip-interfaces.json, and what the code derives from them).
 */

/** @typedef {import("../shift_score").CarData} CarData */
/** @typedef {import("../shift_score").Car} Car */

/**
 * The shift point (ShiftScore.shiftPoint) with hud's own flags.
 * @typedef {object} ShiftPoint
 * @property {number} rpm
 * @property {boolean} cold
 * @property {boolean} now the rpm is at or past it
 * @property {boolean} oilCold
 */
/**
 * What each part is set to in a drive mode (SETUP).
 * @typedef {{ engine: string, chassis: string, steering: string,
 *   gearbox: string }} SetupRows
 */
/**
 * hud's own signal values, raw (DataFrontVehicle).
 * @typedef {{ gapX: ?number, gapY: ?number, speedX: ?number,
 *   speedY: ?number, q: *, at: number }} Ahead
 */
/**
 * GapVehicleDrivingAhead, raw.
 * @typedef {{ gap: ?number, q: unknown, measured: boolean, at: number }} Ahead2
 */
/**
 * The route while guiding (Guidance), raw distances.
 * @typedef {object} Route
 * @property {?number} [leftRaw]
 * @property {?string} [leftText] BMW's formatted distance
 * @property {import("./someip").de.bmw.infotainment.navigation.CommonTypes.DistanceUnit} [leftUnit]
 * @property {?number} [timeLeft] s
 * @property {number} [at]
 * @property {number} [startRaw] the most left seen
 * @property {?number} [doneRaw] travelled
 */
/**
 * _setupVehicleData's extra signals: interface -> field or event -> handler ($pollMs: a poll interval), each handler's
 * payload typed from BMW's catalog (someip.d.ts, tools/gen_someip_types.js).
 * @typedef {import("./someip").Handlers} Signals
 */

const STANDSTILL_KMH = 1; // under this the car stands still
// unit conversions for the "units" setting
const MI_PER_KM = 0.621371;
const PSI_PER_BAR = 14.5038;
const FT_PER_M = 3.28084;
const L_PER_US_GAL = 3.78541;
const LBFT_PER_NM = 0.737562;
const DEFAULT_TANK_L = 65; // config.tankLitres when unset
const BOOST_SCALE = { factor: 0.01, offset: 0, invalid: 255 }; // see header comment
const TYRE_CORNERS = ["FL", "FR", "RL", "RR"];
// the car's display units (Vehicle statusNewCurrentUnitsStatusExt, as BMW's own x_call reads them; car_vitals, MIT)
const PRESS_UNITS = { 1: "BAR", 2: "KPA", 3: "PSI" },
  TEMP_UNITS = { 1: "C", 2: "F" };
/** @type {Record<string, number>} */
const PRESS_TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / PSI_PER_BAR };
/**
 * A unit by wire number (map) or by name, else null.
 * @param {Record<string, string>} map
 * @param {string | number | undefined} unit the field: a wire number or a name
 * @returns {?string}
 */
const unitName = (map, unit) =>
  (unit !== undefined && map[unit]) ||
  (typeof unit === "string" && Object.values(map).indexOf(unit) >= 0 ? unit : null);
// MDrive dataDisplayGearbox.displayProgramGearbox: the programme the cluster shows next to the gear (car_vitals, MIT)
/** @type {Record<string, string>} */
const PROGRAMS = {
  S_MINUS_PROGRAMM: "S",
  M_MINUS_PROGRAMM: "M",
  1: "S",
  2: "M",
};
/** @type {Record<string, string>} */
const MODE_NAME = { comfort: "Comfort", sport: "Sport", eco: "Eco Pro" };
// BMW's route guidance (oap-sdk navigation/guiding: ACTIVE, INACTIVE, CALCULATING_ROUTE)
const GUIDANCE = {
  iface: "de.bmw.infotainment.navigation.guiding.Guidance",
  instance: "Main_Instance",
};
// what BMW's media player shows (the center screen's instance), for {{musicTitle}}
const MEDIA = {
  iface: "de.bmw.infotainment.hmi.hmimediastate.HmiMediaState",
  instance: "HMI_CID",
};
const MEDIA_ITEM = { UNDEFINED: 0, ARTIST: 1, ALBUM: 2, TITLE: 3 };
// the trip computer's consumption unit (ResetLogicTypes.StatusUnitConsumptionBC)
const CONS_UNIT = {
  DEFAULT: 0,
  CONSUMPTION_KM: 1,
  CONSUMPTION_UK: 2,
  CONSUMPTION_US: 3,
  CONSUMPTION_KML: 4,
  CONSUMPTION_KGH2_100KM: 5,
  CONSUMPTION_KGH2_100MI: 6,
};
const GUIDANCE_STATE = { INACTIVE: 0, CALCULATING_ROUTE: 1, ACTIVE: 2 };
// DisplayDataServer functionalLibraryData enums (the car's SOME/IP catalog, someip-interfaces.json): what BMW's HUD
// draws for the driver assistance systems. The car may send the names or the numbers.
const LDM_SYM = { LDM_SYM_NONE: 0 }; // ldmSym: anything else is a symbol (ACC, DCC, STA, ...)
const LDM_COLOR = { LDM_OFF: 0 }; // ldmSymColor: active, standby, critical, ...
const ACC_SYM = { LDM_CAR_OFF: 0 }; // activeCruiseControl.symbolACC: the car ahead
const ACC_BARS = { LDM_OFF: 0 }; // activeCruiseControl.barsColorACC: the distance bars
const STA_WHEEL = {
  LDM_STW_OFF: 0,
  LDM_STW_GREY: 1,
  LDM_STW_GREEN: 2,
  LDM_STW_YELLOW: 4,
  LDM_STW_RED: 8,
};
// GapVehicleAhead qualifiers: DataFrontVehicle's (2 = no data) and GapVehicleDrivingAhead's (6 error, 14 not available, 15 not filled)
const AHEAD_Q = {
  EVENT_DATA_AVAILABLE: 0,
  EVENT_DATA_AVAILABLE_REDUCED: 1,
  EVENT_DATA_NOT_AVAILABLE: 2,
};
const AHEAD2_Q = {
  FUNKTION_VERFUEGBAR: 1,
  FUNKTION_VERFUEGBAR__MINUS__EINGESCHRAENKT: 3,
  FUNKTION_MELDET_FEHLER: 6,
  FUNKTION_NICHT_VERFUEGBAR: 14,
  SIGNAL_UNBEFUELLT: 15,
};
// GapVehicleDrivingAhead statusMeasurementVehicleDrivingAhead: 1..4 is a car measured (new, measured, partly hidden, predicted)
const AHEAD2_MEASURED = {
  KEIN_ELEMENT_GEMESSEN: 0,
  NEUES_ELEMENT__GEMESSEN: 1,
  ELEMENT__GEMESSEN: 2,
  ELEMENT__GEMESSEN__MINUS__TEILWEISE_VERDECKT: 3,
  ELEMENT_PRAEDIZIERT: 4,
};
const REL_TAU_MS = 1500; // the smoothing of a relative speed worked out from the gap
const BRAKE_LIGHT = { INIT: 0, OFF_BL: 1, ON_BL: 2, SIGNAL_UNGUELTIG: 3 };
// body.Light StatusFunctionsIndicators controlIndicateDirection (someip-interfaces.json)
const INDICATE = {
  BLINKEN_AUS: 0,
  TIPP_BLINKEN_LINKS_EIN: 1,
  TIPP_BLINKEN_RECHTS_EIN: 2,
  DAUER_BLINKEN_LINKS_EIN: 3,
  DAUER_BLINKEN_RECHTS_EIN: 4,
  BEIDSEITIGES_BLINKEN_EIN: 8,
  RESERVIERT_NICHT_VERFUEGBAR: 13,
  RESERVIERT_FEHLER: 14,
  SIGNAL_UNBEFUELLT: 15,
};
// Guidance formattedDistance units (CommonTypes.DistanceUnit), by name or number
const ROUTE_UNIT = {
  KM: "km",
  METER: "m",
  MILE_US: "mi",
  MILE_UK: "mi",
  FEET: "ft",
  YARD: "yd",
  0: "ft",
  1: "km",
  2: "m",
  3: "mi",
  4: "mi",
  6: "yd",
};
// the Grand National theme's gear row P R N D S: the letter its needle points at for each selector state (M at S)
// the parking brake and Auto Hold (Vehicle2 statusStandstillFunctions, VehicleStabilizationManagement StandStillFunction, CDS
// statusHandBrake; someip-interfaces.json)
const PARK_BRAKE = {
  PARKBREMSE_MECHANISCH_NICHT_FESTGESTELLT: 0,
  PARKBREMSE_MECHANISCH_FESTGESTELLT: 1,
  PARKBREMSE_IM_STELLVORGANG_LOESEN: 2,
  PARKBREMSE_IM_STELLVORGANG_FESTSTELLEN: 4,
  FUNKTIONSSCHNITTSTELLE_IST_NICHT_VERFUEGBAR: 13,
  FUNKTION_MELDET_FEHLER: 14,
  SIGNAL_UNBEFUELLT: 15,
};
const AUTO_H = {
  AUTOH_NICHT_AKTIVIERT: 0,
  AUTOH_AKTIVIERT_UND_HAELT_FAHRZEUG_NICHT: 1,
  AUTOH_AKTIVIERT_UND_HAELT_FAHRZEUG: 2,
  SIGNAL_UNBEFUELLT: 3,
};
const HAND_BRAKE = {
  NICHT_CODIERT: 0,
  HANDBREMSE_GELOEST: 1,
  HANDBREMSE_ANGEZOGEN: 2,
  SIGNAL_UNGUELTIG: 3,
};
/** @type {Record<string, number>} */
const REGAL_GEARS = { P: 0, R: 1, N: 2, D: 3, S: 4, M: 4 }; // M points at S (the stick on the side): the gear number has its own place
const PEDAL_OK = {
  SIGNALWERT_IST_GUELTIG_UND_ABGESICHERT_UND_PLAUSIBILISIERT: 1,
}; // AngleAcceleratorPedal's qualifier: valid
const VOLT_MS = 2000; // the 12 V reading's interval
const PEDAL_MS = 250; // the OBD pedal reading's interval
const BRAKE_G0 = 0.05,
  BRAKE_GMAX = 1.0; // the brake bar's log scale: deceleration in g where it bends, and where it is full
const BRAKE_TAU_MS = 150; // the deceleration's smoothing for the brake bar
/**
 * An enum field as a number: its wire number, or its name looked up in items (unknown names: null).
 * @param {unknown} value
 * @param {Record<string, number>} items
 * @returns {?number}
 */
function enumNum(value, items) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  return items[value.trim()] !== undefined ? items[value.trim()] : -1; // a name we don't know is some non-off value
}
const FRESH_MS = 3000;
/**
 * The drive mode from FES statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience: names or wire
 * numbers (cauliflowermossgrape's live_data signals.js, MIT): 1 Sport, 2 Sport+, 3 Sport individual,
 * 4 Comfort, 5 Comfort+, 6 Comfort individual, 7 Eco Pro, 8 Eco Pro+, 9 Eco Pro individual, 10 Adaptive.
 */
/** The mode's variant: 'plus' (Sport+ / Comfort+ / Eco Pro+: wire 2, 5, 8, or PLUS / EXPERT in the name), 'individual'
 *  (wire 3, 6, 9, or INDIVID in the name), else null.
 * @param {unknown} raw
 * @returns {?string}
 */
function driveVariantOf(raw) {
  const mode =
    typeof raw === "string" && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : raw;
  if (typeof mode === "number")
    return mode === 2 || mode === 5 || mode === 8
      ? "plus"
      : mode === 3 || mode === 6 || mode === 9
        ? "individual"
        : null;
  if (typeof mode !== "string") return null;
  return /PLUS|EXPERT/i.test(mode)
    ? "plus"
    : /INDIVID/i.test(mode)
      ? "individual"
      : null;
}
/** The M theme's setup rows: what each part is set to in a drive mode (they follow the mode buttons). */
/** @type {Record<string, SetupRows>} */
const SETUP = {
  eco: {
    engine: "EFFICIENT",
    chassis: "COMFORT",
    steering: "COMFORT",
    gearbox: "EFFICIENT",
  },
  comfort: {
    engine: "COMFORT",
    chassis: "COMFORT",
    steering: "COMFORT",
    gearbox: "COMFORT",
  },
  sport: {
    engine: "SPORT",
    chassis: "SPORT",
    steering: "SPORT",
    gearbox: "SPORT",
  },
  sportplus: {
    engine: "SPORT PLUS",
    chassis: "SPORT",
    steering: "SPORT",
    gearbox: "SPORT PLUS",
  },
  // the car reports only that an Individual setup is on, not what each part is set to (no signal found yet)
  individual: {
    engine: "INDIVIDUAL",
    chassis: "INDIVIDUAL",
    steering: "INDIVIDUAL",
    gearbox: "INDIVIDUAL",
  },
};
/** @type {Record<string, number>} */
const SETUP_LEVEL = {
  EFFICIENT: 1,
  COMFORT: 1,
  SPORT: 2,
  "SPORT PLUS": 3,
  INDIVIDUAL: 0,
};
/**
 * The drive mode: 'sport', 'comfort' or 'eco' (above), else null.
 * @param {unknown} raw
 * @returns {?string}
 */
function driveModeOf(raw) {
  let mode = raw;
  if (typeof mode === "string" && /^\d+$/.test(mode.trim()))
    mode = Number(mode.trim());
  if (typeof mode === "number") {
    if (mode >= 1 && mode <= 3) return "sport";
    if (mode >= 7 && mode <= 9) return "eco";
    if ((mode >= 4 && mode <= 6) || mode === 10) return "comfort";
    return null;
  }
  if (typeof mode !== "string") return null;
  const name = mode.trim().toUpperCase();
  if (name.indexOf("SPORT") === 0) return "sport";
  if (name.indexOf("ECO") === 0) return "eco";
  if (name.indexOf("COMFORT") === 0 || name.indexOf("ADAPTIVE") === 0)
    return "comfort";
  return null;
}

module.exports = {
  BOOST_SCALE,
  TYRE_CORNERS,
  PRESS_UNITS,
  TEMP_UNITS,
  PRESS_TO_BAR,
  unitName,
  PROGRAMS,
  MODE_NAME,
  GUIDANCE,
  MEDIA,
  MEDIA_ITEM,
  CONS_UNIT,
  GUIDANCE_STATE,
  LDM_SYM,
  LDM_COLOR,
  ACC_SYM,
  ACC_BARS,
  STA_WHEEL,
  AHEAD_Q,
  AHEAD2_Q,
  AHEAD2_MEASURED,
  REL_TAU_MS,
  BRAKE_LIGHT,
  INDICATE,
  ROUTE_UNIT,
  PARK_BRAKE,
  AUTO_H,
  HAND_BRAKE,
  REGAL_GEARS,
  PEDAL_OK,
  VOLT_MS,
  PEDAL_MS,
  BRAKE_G0,
  BRAKE_GMAX,
  BRAKE_TAU_MS,
  enumNum,
  FRESH_MS,
  STANDSTILL_KMH,
  MI_PER_KM,
  PSI_PER_BAR,
  FT_PER_M,
  L_PER_US_GAL,
  LBFT_PER_NM,
  DEFAULT_TANK_L,
  driveVariantOf,
  SETUP,
  SETUP_LEVEL,
  driveModeOf,
};
