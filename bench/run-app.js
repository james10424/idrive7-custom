"use strict";
/**
 * Bench launcher: runs the BUILT app (dist/<id>, made by kit/tools/build.py, the
 * same build the Store runs on the car) inside the kit's stubbed head unit (kit/tools/hu-stub.js,
 * live mode). No BMW SDK, no SOME/IP:
 *
 *  - The center-screen page is hu-stub's fake RHMI. A setting from the bench panel is sent the way
 *    the car's HMI sends it: an 'action' on the SET_<KEY> component (the drop-down's row, or a
 *    checkbox press), so the kit's own wireSettings() handles it and saves bench/.data/<id>/settings.json.
 *  - The status row (ctx.ui.text('STATUS', ...)) is reported to the page.
 *  - Manual signals go in as RAW SOME/IP values through hu.feed, the scaling car.js undoes on the
 *    car; the FES boost field too. Demo mode is the kit's sim.js (the "demo" setting).
 *  - HUD_CLUSTER_SOCKET points hud.js at the bench's fake cluster-render socket.
 *
 * Run by bench/server.js as a forked child: node bench/run-app.js <stage dir> <data dir>
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

/**
 * The page's manual signals by name (rpm, speed, gear, ...), music a string.
 * @typedef {Record<string, number | string>} ManualValues
 */
/**
 * A message from bench/server.js.
 * @typedef {{ t: "signals", mode: "demo" | "manual", values: ManualValues }
 *   | { t: "set", key: string, value: any }
 *   | { t: "drive", value: number | null }
 *   | { t: "nav", value: string | null }
 *   | { t: "assist", value: "acc" | "off" | null }
 *   | { t: "car", key: string, value: string | null }} ToApp
 */
/**
 * A message to bench/server.js, which adds app (the app id) and passes it on to the page.
 * @typedef {{ t: "status", s: string, d: string, app?: string }
 *   | { t: "settings", schema: any, values: Record<string, any>, app?: string }
 *   | { t: "values", mode: string, values: Record<string, number | null>, app?: string }} FromApp
 */

const stage = process.argv[2],
  dataDir = process.argv[3];
if (!stage || !dataDir) {
  console.error("usage: run-app.js <dist/<id>> <data dir>");
  process.exit(2);
}

/** @param {FromApp} msg */
const send = (msg) => {
  if (process.connected) process.send(msg);
};
/**
 * Log arguments as one line.
 * @param {any[]} args
 * @returns {string}
 */
const fmt = (args) =>
  args
    .map((arg) =>
      arg && arg.stack
        ? arg.stack
        : typeof arg === "object"
          ? JSON.stringify(arg)
          : String(arg),
    )
    .join(" ");
const tag = "[" + path.basename(stage) + "] ";
const log = {
  info: (...args) => console.log(tag + fmt(args)),
  warn: (...args) => console.warn(tag + "WARN " + fmt(args)),
  error: (...args) => console.warn(tag + "ERROR " + fmt(args)),
  debug: () => {},
};
// As on the car, an uncaught exception ends the app (kit/mgu.js): the bench shows the exit.
process.on("uncaughtException", (err) => {
  log.error(
    "uncaught (the car would exit the app here): " +
      ((err && err.stack) || err),
  );
  process.exit(1);
});

try {
  fs.mkdirSync(dataDir);
} catch (err) {
  /* there */
}
const { headUnit } = require(
  path.join(__dirname, "..", "kit", "tools", "hu-stub.js"),
);
const stub = headUnit(stage, {
  live: true,
  dataDir,
  log,
  image: () => Promise.resolve(),
});
const { spec, settings, ui } = stub;

// the app's HudApp instance, for the values the page shows (hud.js is loaded by the app's main.js)
/** @type {any} */
let hud = null;
const realLoad = Module._load;
/**
 * @param {string} req
 * @returns {any}
 */
Module._load = function (req) {
  const exported = realLoad.apply(this, arguments);
  if (req === "./hud" && typeof exported === "function" && !exported.__bench) {
    const Wrapped = class extends exported {
      constructor(ctx) {
        super(ctx);
        hud = this;
      }
    };
    Wrapped.__bench = true;
    return Wrapped;
  }
  return exported;
};

// the center screen's status row
let status = "",
  detail = "";
const text = ui.text;
/**
 * @param {string} name component name
 * @param {any} value
 * @param {number} [row]
 * @param {number} [cell]
 */
ui.text = (name, value, row, cell) => {
  if (name === "STATUS" && !row) {
    status = String(value);
    send({ t: "status", s: status, d: detail });
  }
  if (name === "DETAIL" && !row) {
    detail = String(value).trim();
    send({ t: "status", s: status, d: detail });
  }
  return text(name, value, row, cell);
};

/** @returns {void} */
const sendSettings = () =>
  send({
    t: "settings",
    schema: spec.settings,
    values: Object.assign({}, settings.values),
  });
settings.onChange(sendSettings);

/**
 * A setting from the panel, pressed on the fake HMI as the car's HMI would.
 * @param {string} key
 * @param {any} value
 * @returns {void}
 */
function press(key, value) {
  const item = settings.item(key);
  if (!item) return log.warn("bench: no setting " + key);
  const comp = ui.comp("SET_" + key.toUpperCase());
  if (item.type === "bool") {
    if (!!settings.get(key) !== !!value) comp.emit("action", {}); // a checkbox press toggles
    return;
  }
  const rows =
    item.type === "choice"
      ? item.options.map((option) => option[0])
      : item.steps;
  const row = rows.indexOf(value);
  if (row < 0)
    return log.warn("bench: " + key + " has no value " + JSON.stringify(value));
  comp.emit("action", { row });
}

// manual signals as raw SOME/IP values (a copy of kit/runtime/car.js SCALE; FES boost from hud.js)
/** @type {Record<string, [number, number]>} name to [scale, offset] */
const SCALE = {
  rpm: [0.25, 0],
  speed: [0.015625, 0],
  accel: [0.002, -65],
  temp: [1, -48],
  torque: [0.5, -1023.5],
  boost: [0.01, 0],
};
/**
 * A value in the car's units as the raw SOME/IP number.
 * @param {string} k a SCALE name
 * @param {number} value
 * @returns {number}
 */
const raw = (k, value) => Math.round((value - SCALE[k][1]) / SCALE[k][0]);
// how often each feed goes out
const SLOW_FEED_MS = 1000; // once a second, as the car sends these
const TRIP_FEED_MS = 2000; // the trip computer
const SIGNAL_FEED_MS = 50; // the manual signals
const VALUES_FEED_MS = 250; // what the app sees, to the page
const CAR_SW_POLL_MS = 500; // a look for a changed car switch
const SONG_MS = 8000; // how long each demo song plays
// the made-up route while GUIDING
const ROUTE_M = 24000; // its length
const ROUTE_LAP_MS = 240000; // driven in 4 minutes, then again
const ROUTE_SPEED_MPS = 13.9; // the average speed its time left assumes, about 50 km/h
const ROUTE_DELAY_S = 120; // the traffic delay, in the time left too
// the trip computer's average consumption: 9.8 l/100km as scale / 10^digit
const DEMO_CONSUMPTION_SCALE = 98,
  DEMO_CONSUMPTION_DIGIT = 1;
const NO_VALUE_U16 = 65535; // a 16 bit field's "no value"
// the assistance block with ACC on
const DEMO_ACC_BARS = 3; // the distance bars
const DEMO_ACC_SET_SPEED = 152; // cruiseCtrlSpeedHUD
// the car ahead
const GAP_SWING_MS = 4000; // sin(t / this): one swing in about 25 s
const GAP_MEAN_RAW = 200,
  GAP_SWING_RAW = 50; // 20 m +- 5 m in 0.1 m steps
const AHEAD_NONE = 253; // the gap and object id with nothing measured
const FRONT_NO_OBJECT = 4093; // DataFrontVehicle's fields with no object
const G_MPS2 = 9.80665; // one g, as car.js divides by
// manual values the page has not sent yet
const DEMO_COOLANT_C = 90,
  DEMO_OIL_C = 100,
  DEMO_FUEL_L = 40,
  DEMO_RANGE_KM = 450,
  DEMO_ODO_KM = 23817,
  DEMO_AMBIENT_C = 22,
  DEMO_TYRE_BAR = 2.3,
  DEMO_TYRE_C = 24;
// ExteriorTemperature temperatureExterior: raw * 0.5 - 40 C
const AMBIENT_C_PER_BIT = 0.5,
  AMBIENT_OFFSET_C = 40;
// statusNewCurrentUnitsStatusExt wire numbers (PRESS_UNITS, TEMP_UNITS in shared/car/consts.js)
const UNIT_BAR = 1,
  UNIT_C = 1;
// TPMS: pressure in 0.1 bar, temperature raw - 40 C; the rear pair a notch higher
const TYRE_RAW_PER_BAR = 10,
  TYRE_OFFSET_C = 40;
const REAR_PRESSURE_STEP = 2, // 0.2 bar
  REAR_TEMP_STEP = 3; // 3 C
let mode = "demo",
  /** @type {ManualValues} */
  manual = {},
  /** @type {number | null} */
  drive = null,
  /** @type {string | null} */
  nav = null,
  /** @type {"acc" | "off" | null} */
  assist = null,
  /** @type {Record<string, string>} */
  carSw = {};
// the drive mode buttons, sent once a second as the car does on change (wire numbers: 1 Sport, 4 Comfort, 7 Eco Pro)
setInterval(() => {
  if (drive !== null)
    stub.feed(
      "de.bmw.infotainment.drivingexcitement.FES",
      "statusFESVehicleDynamicSwitchHMI",
      { actualValueModeDrivingExperience: drive },
    );
}, SLOW_FEED_MS);
// route guidance (Guidance guidanceState, the enum names oap-sdk reads), sent once a second
setInterval(() => {
  if (nav !== null)
    stub.feed(
      "de.bmw.infotainment.navigation.guiding.Guidance",
      "guidanceState",
      nav,
    );
}, SLOW_FEED_MS);
// while GUIDING: a made-up 24 km route, driven in 4 minutes and then again (finalDestinationInfo, travelledDistance)
let routeT0 = 0;
setInterval(() => {
  if (nav !== "ACTIVE") {
    routeT0 = 0;
    return;
  }
  if (!routeT0) routeT0 = Date.now();
  const total = ROUTE_M,
    done = total * (((Date.now() - routeT0) / ROUTE_LAP_MS) % 1),
    left = total - done;
  stub.feed(
    "de.bmw.infotainment.navigation.guiding.Guidance",
    "finalDestinationInfo",
    {
      travelTime: Math.round(left / ROUTE_SPEED_MPS + ROUTE_DELAY_S),
      delayTime: ROUTE_DELAY_S,
      delayStatus: "YELLOW",
      formattedDistance: {
        distance: (left / 1000).toFixed(1),
        unit: "KM",
        rawDistance: left,
      },
      distanceFromCurrentToFinalDestination: left,
      isCheckeredFlag: true,
    },
  );
  stub.feed(
    "de.bmw.infotainment.navigation.guiding.Guidance",
    "travelledDistance",
    { distance: (done / 1000).toFixed(1), unit: "KM", rawDistance: done },
  );
}, SLOW_FEED_MS);
// the trip computer (ResetLogic) as the car would send it: 9.8 l/100km since refuelling, scale / 10^digit
setInterval(() => {
  stub.feed("de.bmw.infotainment.resetlogic.ResetLogic", "averageConsumption", {
    consumptionCombustionCurrentScale: DEMO_CONSUMPTION_SCALE,
    consumptionCombustionCurrentDigit: DEMO_CONSUMPTION_DIGIT,
    consumptionElectricCurrentScale: NO_VALUE_U16,
    consumptionElectricCurrentDigit: 0,
    combustionUnit: "CONSUMPTION_KM",
    electricUnit: "DEFAULT",
  });
}, TRIP_FEED_MS);
// now playing (HmiMediaState playerMetadata, as BMW's player fills it: artist then title): manual "music", else a few
// titles in different scripts, a new one every 8 s
const DEMO_SONGS = [
  ["Queen", "Bohemian Rhapsody"],
  ["YOASOBI", "夜に駆ける"],
  ["BTS", "봄날 Spring Day"],
  ["Кино", "Группа крови"],
  [
    "Daft Punk",
    "Harder, Better, Faster, Stronger (Alive 2007 version, extended)",
  ],
];
setInterval(() => {
  const song =
    mode === "manual"
      ? typeof manual.music === "string"
        ? ["", manual.music]
        : null
      : DEMO_SONGS[Math.floor(Date.now() / SONG_MS) % DEMO_SONGS.length];
  // as the car's player sends it (Nov 9 2026): playerMetadata holds only the artist and the album; the title is in the
  // track list, found by the playing track's id
  const id = song ? DEMO_SONGS.indexOf(song) + 1 : 0;
  stub.feed(
    "de.bmw.infotainment.hmi.hmimediastate.HmiMediaState",
    "playerMetadata",
    song
      ? {
          uiType: "TWO_LINES",
          trackId: id,
          firstLineText: song[0] || "Unknown artist",
          firstLineType: "ARTIST",
          secondLineText: "Unknown album",
          secondLineType: "ALBUM",
          threeRowText: "",
        }
      : {
          uiType: "UNDEFINED",
          trackId: 0,
          firstLineText: "",
          firstLineType: "UNDEFINED",
          secondLineText: "",
          secondLineType: "UNDEFINED",
          threeRowText: "",
        },
  );
  stub.feed("de.bmw.infotainment.hmi.hmimediastate.HmiMediaState", "tracks", {
    sessionId: 1,
    startIndex: 0,
    totalLength: DEMO_SONGS.length + 1,
    tracks: DEMO_SONGS.map((demo, i) => ({
      trackId: i + 1,
      firstLine: demo[1],
      firstLineExtension: "",
      secondLine: demo[0],
    })).concat(
      song && song[0] === ""
        ? [
            {
              trackId: 0,
              firstLine: song[1],
              firstLineExtension: "",
              secondLine: "",
            },
          ]
        : [],
    ),
  });
  stub.feed(
    "de.bmw.infotainment.hmi.hmimediastate.HmiMediaState",
    "trackSelection",
    { sessionId: 1, selectedTrackId: song && song[0] === "" ? 0 : id },
  );
}, SLOW_FEED_MS);
// BMW's HUD driver assistance block (DisplayDataServer functionalLibraryData, the catalog's enum names): ACC with a car ahead, or all off
let assistOnce = null; // a single "all off" after "not sent" (see the message handler)
setInterval(() => {
  const state = assist !== null ? assist : assistOnce;
  assistOnce = null;
  if (state === null) return;
  const on = state === "acc";
  stub.feed(
    "de.bmw.infotainment.displaydataserver.DisplayDataServer",
    "functionalLibraryData",
    {
      ldmSym: on ? "LDM_SYM_ACC" : "LDM_SYM_NONE",
      ldmSymColor: on ? "LDM_ACTIVE" : "LDM_OFF",
      activeCruiseControl: {
        symbolACC: on ? "LDM_CAR_NORMAL" : "LDM_CAR_OFF",
        barsColorACC: on ? "LDM_ACTIVE" : "LDM_OFF",
        accBarsHUD: on ? DEMO_ACC_BARS : 0,
      },
      trafficJamAssist: { steeringWheel: on ? "LDM_STW_GREEN" : "LDM_STW_OFF" },
      cruiseCtrlSpeedHUD: on ? DEMO_ACC_SET_SPEED : 0,
    },
  );
  // the car ahead (de.bmw.dass.GapVehicleAhead) as an X3 sends it: only GapVehicleDrivingAhead, once a second, 253 and
  // "nothing measured" without a car; with ACC on here a measured car whose gap swings 15..25 m over ~25 s (raw in 0.1 m
  // steps, as the car's reading was 10 times BMW's own at 1:1)
  const t = Date.now() / GAP_SWING_MS,
    gap = on
      ? Math.round(GAP_MEAN_RAW + GAP_SWING_RAW * Math.sin(t))
      : AHEAD_NONE;
  stub.feed("de.bmw.dass.GapVehicleAhead", "GapVehicleDrivingAhead", {
    qualifierFunctionVehicleDrivingAhead: "FUNKTION_VERFUEGBAR",
    statusMeasurementVehicleDrivingAhead: on
      ? "ELEMENT__GEMESSEN"
      : "KEIN_ELEMENT_GEMESSEN",
    gapVehicleDrivingAhead: gap,
    vehicleTypeVehicleDrivingAhead: on
      ? "ZWEISPURIGES_FAHRZEUG"
      : "SIGNAL_UNGUELTIG",
    lampStatusVehicleDrivingAhead: on ? "LICHT_AUS" : "SIGNAL_UNGUELTIG",
  });
  // DataFrontVehicle as the car sends it with no object: 4093 in every field, object id 253 (its speed is not used)
  stub.feed("de.bmw.dass.GapVehicleAhead", "DataFrontVehicle", {
    frontVehicleObjectID: AHEAD_NONE,
    frontVehicleSpeedX: FRONT_NO_OBJECT,
    frontVehicleSpeedY: FRONT_NO_OBJECT,
    frontVehicleGapX: FRONT_NO_OBJECT,
    frontVehicleGapY: FRONT_NO_OBJECT,
    qualifierEventDataFunctionFrontVehicle: "EVENT_DATA_AVAILABLE",
    qualifierExtendedFunctionFrontVehicle: "NORMAL_OPERATION_MODE",
  });
}, SLOW_FEED_MS);
setInterval(() => {
  if (mode !== "manual") return;
  const values = manual,
    /**
     * The manual value k when it is a number, else d.
     * @param {string} k
     * @param {number} d
     * @returns {number}
     */
    num = (k, fallback) =>
      typeof values[k] === "number" && isFinite(values[k])
        ? values[k]
        : fallback;
  const gear = Math.round(num("gear", 0));
  stub.feed("de.bmw.infotainment.vehicle.CDS", "statusEngineSpeed2", {
    actualValueRPMEngineCrankshaft: raw("rpm", num("rpm", 0)),
  });
  stub.feed("de.bmw.infotainment.vehicle.Vehicle2", "statusCarSpeed2", {
    speedVehicleCentreOfGravity: raw("speed", num("speed", 0)),
  });
  stub.feed(
    "de.bmw.infotainment.vehicle.CDS2",
    "statusLongitudinalAccelerationMassCenter",
    {
      longitudinalAccelerationCentreOfGravity: raw(
        "accel",
        num("gLong", 0) * G_MPS2,
      ),
    },
  );
  stub.feed(
    "de.bmw.infotainment.vehicle.CDS2",
    "statusLateralAccelerationMassCenter",
    {
      lateralAccelerationCentreOfGravity: raw(
        "accel",
        num("gLat", 0) * G_MPS2,
      ),
    },
  );
  stub.feed("de.bmw.infotainment.vehicle.CDS", "statusEngineTemperature", {
    temperatureEngineDrive: raw("temp", num("coolant", DEMO_COOLANT_C)),
    temperatureEngineOilDrive: raw("temp", num("oil", DEMO_OIL_C)),
  });
  // the selector switch: P / R / N as the car sends them (no gear; R's own), D / S / M in the gear slider's gear (at
  // least 1); unset, the gear slider alone (in gear: D, else P)
  const sel = carSw.selector,
    parked = sel === "P" || sel === "R" || sel === "N",
    driveGear = sel ? Math.max(1, gear) : gear;
  stub.feed("de.bmw.infrastructure.VehicleInformation", "statusGearboxDrive", {
    statusActualGearDrive: parked
      ? sel === "R"
        ? "R"
        : "N_OR_P"
      : driveGear > 0
        ? "G" + driveGear
        : "N_OR_P",
    statusActualStageDrive: parked ? sel : driveGear > 0 ? "D" : "P",
  });
  stub.feed(
    "de.bmw.infotainment.drivingexcitement.FES",
    "statusActualValueTorque2",
    { actualValueTorqueCrankshaft: raw("torque", num("torque", 0)) },
  );
  stub.feed(
    "de.bmw.infotainment.drivingexcitement.FES",
    "statusSwitchDriveDynamicSport2",
    { displayBoostPressure: raw("boost", Math.max(0, num("boost", 0))) },
  );
  stub.feed("de.bmw.infotainment.KombiIF", "statusRangeTankStatus", {
    fluidLevelFuelTank: Math.round(num("fuelL", DEMO_FUEL_L)),
    range: Math.round(num("range", DEMO_RANGE_KM)),
    mileageKilometre: Math.round(num("odo", DEMO_ODO_KM)),
  });
  stub.feed(
    "de.bmw.infrastructure.EnvironmentalInformation",
    "ExteriorTemperature",
    {
      temperatureExterior: Math.round(
        (num("ambient", DEMO_AMBIENT_C) + AMBIENT_OFFSET_C) / AMBIENT_C_PER_BIT,
      ),
    },
  );
  // the car's display units (bar, C), so the tyre values below read as 0.1 bar and C + 40; the shifter programme: S / M
  // from the selector switch, else D
  stub.feed(
    "de.bmw.infotainment.vehicle.Vehicle",
    "statusNewCurrentUnitsStatusExt",
    {
      unitOfMeasurementAirPressure: UNIT_BAR,
      unitOfMeasurementTemperature: UNIT_C,
    },
  );
  stub.feed("de.bmw.infotainment.misc.MDrive", "dataDisplayGearbox", {
    displayProgramGearbox:
      sel === "S"
        ? "S_MINUS_PROGRAMM"
        : sel === "M"
          ? "M_MINUS_PROGRAMM"
          : "D_PROGRAMM",
  });
  // tyres (TPMS, the fields the car answers a read with): pressure in 0.1 bar, temperature raw - 40 C; the rear pair a notch higher
  const pressure = Math.round(num("tyreP", DEMO_TYRE_BAR) * TYRE_RAW_PER_BAR),
    temperature = Math.round(num("tyreT", DEMO_TYRE_C) + TYRE_OFFSET_C);
  stub.feed("de.bmw.infotainment.vehicle.TPMS", "statusTyrePressure", {
    actualValuePressureTyreFLH: pressure,
    actualValuePressureTyreFRH: pressure,
    actualValuePressureTyreRLH: pressure + REAR_PRESSURE_STEP,
    actualValuePressureTyreRRH: pressure + REAR_PRESSURE_STEP,
  });
  stub.feed("de.bmw.infotainment.vehicle.TPMS", "statusTyreTemperature", {
    actualValueTemperatureTyreFLH: temperature,
    actualValueTemperatureTyreFRH: temperature,
    actualValueTemperatureTyreRLH: temperature + REAR_TEMP_STEP,
    actualValueTemperatureTyreRRH: temperature + REAR_TEMP_STEP,
  });
}, SIGNAL_FEED_MS);

// what the app actually sees, so the page shows demo values too
setInterval(() => {
  if (!hud) return;
  const data = hud.car.data(),
    /** @type {Record<string, number | null>} */
    out = {};
  ["rpm", "speed", "oil", "coolant", "gear", "gLong", "gLat", "torque"].forEach(
    (name) => {
      out[name] = data[name] === undefined ? null : data[name];
    },
  );
  out.boost = hud._boost();
  out.fuelL = hud.fuelL;
  out.range = hud.rangeKm;
  out.ambient = hud.ambient;
  send({ t: "values", mode, values: out });
}, VALUES_FEED_MS);

// the page's car switches, as the car sends each message (catalog enum names), in demo and manual alike; a switch left at
// "not sent" sends nothing
/** @type {Record<string, (value: string) => void>} */
const CAR_SW = {
  turn: (value) =>
    stub.feed("de.bmw.body.Light", "StatusFunctionsIndicators", {
      controlIndicateDirection: {
        off: "BLINKEN_AUS",
        left: "DAUER_BLINKEN_LINKS_EIN",
        right: "DAUER_BLINKEN_RECHTS_EIN",
        hazard: "BEIDSEITIGES_BLINKEN_EIN",
      }[value],
      activeFunctionIndicateDirection:
        value === "hazard"
          ? "WARNBLINKEN_MANUELL"
          : value === "off"
            ? "BLINKEN_AUS"
            : value === "left"
              ? "DAUERBLINKEN_LINKS"
              : "DAUERBLINKEN_RECHTS",
    }),
  brakeLights: (value) =>
    stub.feed("de.bmw.body.Light", "LampExterior", {
      controlFunctionBrakeLight: value === "on" ? "ON_BL" : "OFF_BL",
    }),
  parkBrake: (value) =>
    stub.feed(
      "de.bmw.infotainment.vehicle.Vehicle2",
      "statusStandstillFunctions",
      {
        statusParkingBrake:
          value === "set"
            ? "PARKBREMSE_MECHANISCH_FESTGESTELLT"
            : "PARKBREMSE_MECHANISCH_NICHT_FESTGESTELLT",
      },
    ),
  autoHold: (value) =>
    stub.feed(
      "de.bmw.chassis.VehicleStabilizationManagement",
      "StandStillFunction",
      {
        statusAutoH: {
          off: "AUTOH_NICHT_AKTIVIERT",
          armed: "AUTOH_AKTIVIERT_UND_HAELT_FAHRZEUG_NICHT",
          hold: "AUTOH_AKTIVIERT_UND_HAELT_FAHRZEUG",
        }[value],
      },
    ),
};
// sent when a switch changes (and once when the app starts), as the car's subscriptions report changes, not on a
// timer: a timer here hid an app that forgot a signal held longer than a few seconds
/** @type {Record<string, string>} */
const carSwSent = {};
setInterval(
  () =>
    Object.keys(carSw).forEach((k) => {
      if (CAR_SW[k] && carSw[k] && carSwSent[k] !== carSw[k]) {
        carSwSent[k] = carSw[k];
        CAR_SW[k](carSw[k]);
      }
    }),
  CAR_SW_POLL_MS,
);

process.on(
  "message",
  /** @param {ToApp} msg */ (msg) => {
    if (!msg) return;
    if (msg.t === "signals") {
      mode = msg.mode === "manual" ? "manual" : "demo";
      manual = msg.values || {};
      // demo drive = the kit's sim; manual = live data (auto: the sim gives way once data arrives)
      const want = mode === "manual" ? "off" : "on";
      if (settings.get("demo") !== want) press("demo", want);
    } else if (msg.t === "set") press(msg.key, msg.value);
    else if (msg.t === "drive") drive = msg.value;
    else if (msg.t === "nav") {
      // "not sent" after a value: the app would keep the last state it saw (a route that never ends, the HUD giving way
      // for good), so it hears "no route" once, as from a car that has none, and then nothing
      if (msg.value === null && nav !== null)
        stub.feed(
          "de.bmw.infotainment.navigation.guiding.Guidance",
          "guidanceState",
          "INACTIVE",
        );
      nav = msg.value;
    } else if (msg.t === "assist") {
      // the same for the assistance block: "all off" once, then nothing
      if (msg.value === null && assist !== null) assistOnce = "off";
      assist = msg.value;
    } else if (msg.t === "car") {
      if (msg.value) carSw[msg.key] = msg.value;
      else delete carSw[msg.key];
    }
  },
);
process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

stub.start();
sendSettings();
log.info(
  "bench: app loaded from " +
    path.relative(process.cwd(), stage) +
    ", data in " +
    dataDir,
);
