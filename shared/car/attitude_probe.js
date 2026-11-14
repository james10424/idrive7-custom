"use strict";
/**
 * Attitude probe (the F-16 layout's pitch ladder, horizon and heading): which of the car's SOME/IP interfaces give
 * the car's pitch, roll and heading. Off unless the app's data folder has a file named attitude-probe (touch it over
 * ssh and restart the app); then it watches every candidate below and writes what each sends to
 * data/attitude-probe.log: an interface's availability, its first message whole, then each field's numbers whenever
 * they change (at most every PROBE_LINE_MS), with the speed and the g at that moment, so a drive up a slope, round a
 * bend and through a turn can be read against them. Reads only.
 *
 * The candidates come from the unit's catalog (bmw_sdk someip-interfaces.json); app.json "signals" lists each as
 * optional, so a unit without one still installs.
 */
const fs = require("fs");
const path = require("path");

const PROBE_FLAG = "attitude-probe"; // in the data folder: the probe runs
const PROBE_LOG = "attitude-probe.log"; // in the data folder: what it found
const PROBE_LINE_MS = 250; // a field's line at most this often
const PROBE_FIRST_CHARS = 1500; // an interface's first message, cut to this
const PROBE_POLL_MS = 1000; // fields with a getter but no notifier are read this often
const PROBE_LOG_MAX = 4 * 1024 * 1024; // the log stops growing past this

/** @type {Array<{ iface: string, instance: string, fields: string[], poll?: boolean, what: string }>} */
const CANDIDATES = [
  { iface: "de.bmw.infotainment.vehicle.VehiclePitchAngle", instance: "1", fields: ["vehicleAngle"], what: "pitch angle" },
  { iface: "de.bmw.chassis.VehicleModel", instance: "1", fields: ["LaneSlope", "OdometryVehicle1"], what: "road gradient, transverse gradient; yaw angle" },
  { iface: "de.bmw.chassis.RollPitchRateAccelerationVerticalProvision", instance: "1", fields: ["pitchRateCog", "rollRateCog"], what: "pitch and roll rates" },
  { iface: "de.bmw.chassis.SurfaceInformationProvision", instance: "1", fields: ["longitudinalGradientSurface", "lateralGradientSurface"], what: "surface gradients" },
  { iface: "de.bmw.chassis.YawRateProvision", instance: "1", fields: ["yawRate"], what: "yaw rate" },
  { iface: "de.bmw.infotainment.navigation.positioning.Positioning", instance: "Main_Instance", fields: ["currentLocation"], what: "heading (navigation)" },
  { iface: "de.bmw.infotainment.navigation.mapcontrol.MapControl", instance: "Main_Instance_01", fields: ["compassAngle"], what: "compass (map)" },
  { iface: "de.bmw.infotainment.GPSData", instance: "1", fields: ["GPSPositionExtendedCAN"], what: "GPS heading" },
  { iface: "de.bmw.infotainment.navigation.ADAS", instance: "1", fields: ["navigationGPS2"], poll: true, what: "heading (ADAS horizon)" },
];

/**
 * A message's numbers, flattened: "a.b.c=1.23" (enums and strings as they come), for a compact changing line.
 * @param {*} value
 * @param {string} [prefix]
 * @param {string[]} [out]
 * @returns {string[]}
 */
function leaves(value, prefix, out) {
  const list = out || [];
  const at = prefix || "";
  if (value === null || value === undefined) return list;
  if (typeof value === "number") list.push(at + "=" + (Number.isInteger(value) ? value : value.toFixed(3)));
  else if (typeof value === "string" || typeof value === "boolean") list.push(at + "=" + value);
  else if (Array.isArray(value)) value.slice(0, 8).forEach((v, i) => leaves(v, at + "[" + i + "]", list));
  else if (typeof value === "object")
    Object.keys(value).forEach((k) => {
      // CRC frames and counters change on every message: left out so a line means a value moved
      if (/^(cRC|counter|length|dataID|alive)/i.test(k)) return;
      leaves(value[k], at ? at + "." + k : k, list);
    });
  return list;
}

/**
 * Starts the probe if the data folder has its flag file.
 * @param {*} hud the HudApp (ctx.signals, ctx.dataDir, car)
 */
function start(hud) {
  const dir = hud.ctx && hud.ctx.dataDir;
  if (!dir || !fs.existsSync(path.join(dir, PROBE_FLAG))) return;
  const signals = hud.ctx.signals;
  const file = path.join(dir, PROBE_LOG);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    /* a new log */
  }
  /** @param {string} line */
  const write = (line) => {
    if (size > PROBE_LOG_MAX) return;
    const text = new Date().toISOString().substr(11, 12) + " " + line + "\n";
    size += text.length;
    fs.appendFile(file, text, () => {});
  };
  const context = () => {
    const d = hud.car && hud.car.data ? hud.car.data() : {};
    /** @type {(v: *) => string} */
    const n = (v) => (typeof v === "number" ? v.toFixed(2) : "-");
    return "(speed " + n(d.speed) + " gLong " + n(d.gLong) + " gLat " + n(d.gLat) + ")";
  };
  write("probe start: " + CANDIDATES.length + " interfaces; signals module " + (signals && signals.hasNative && signals.hasNative() ? "native" : "missing"));
  hud.log.info("attitude probe: on, writing " + file);
  CANDIDATES.forEach((c) => {
    /** @type {Record<string, { first: boolean, last: string, at: number }>} */
    const seen = {};
    /** @type {Record<string, (v: *) => void>} */
    const handlers = {};
    c.fields.forEach((f) => {
      seen[f] = { first: false, last: "", at: 0 };
      handlers[f] = (v) => {
        const s = seen[f];
        const name = c.iface.split(".").pop() + "." + f;
        if (!s.first) {
          s.first = true;
          let whole = "";
          try {
            whole = JSON.stringify(v);
          } catch (err) {
            whole = String(v);
          }
          write("FIRST " + name + " [" + c.what + "] " + whole.substr(0, PROBE_FIRST_CHARS));
        }
        const line = leaves(v).join(" ");
        const now = Date.now();
        if (line === s.last || now - s.at < PROBE_LINE_MS) return;
        s.last = line;
        s.at = now;
        write(name + " " + context() + " " + line);
      };
    });
    signals
      .watch(c.iface, c.instance, handlers, hud.log, c.poll ? { pollMs: PROBE_POLL_MS } : undefined)
      .then((/** @type {*} */ sub) => {
        write(c.iface + " (" + c.instance + "): " + (sub && sub.error ? "error " + sub.error : "subscribed") + "; available " + !!(sub && sub.available));
        if (sub && !sub.error) {
          // its availability a few seconds on (the provider may come up late)
          setTimeout(() => write(c.iface + ": available after 10 s " + !!sub.available), 10000);
        }
      })
      .catch((/** @type {*} */ err) => write(c.iface + ": " + err));
  });
}

module.exports = { start, CANDIDATES };
