"use strict";
/**
 * The head unit's CPU and temperature for the settings page, on one row (main.js): the whole unit's CPU over the last sample, ours
 * beside it (Custom HUD, Custom Cluster, cluster-render, Live2D Render), and the processor's package temperature
 * (coretemp). The same figures as tools/car_usage.sh, read the same way: /proc and /sys, all readable by any app on
 * the car. Node 8.
 */
const fs = require("fs");
const path = require("path");

const OAP = "/var/opt/public/oap";
const OUR_APPS = ["custom_cluster"]; // besides this app itself (process.pid)
const OUR_PROGRAMS = ["cluster-render", "live2d-render"]; // by name (comm: 15 characters at most)
const HWMON = "/sys/class/hwmon";

/** @type {(f: string) => ?string} */
function read(f) {
  try {
    return fs.readFileSync(f, "utf8");
  } catch (e) {
    return null;
  }
}

/** @returns {?{ busy: number, total: number, cores: number }} all cores together, in clock ticks */
function cpuTotals() {
  const stat = read("/proc/stat");
  if (!stat) return null;
  const line = stat.split("\n")[0].trim().split(/\s+/);
  if (line[0] !== "cpu") return null;
  const v = line.slice(1).map(Number);
  // user nice system idle iowait irq softirq steal
  const busy = v[0] + v[1] + v[2] + v[5] + v[6] + (v[7] || 0);
  const cores = stat.split("\n").filter((l) => /^cpu\d/.test(l)).length || 1;
  return { busy: busy, total: busy + v[3] + v[4], cores: cores };
}

/** @returns {string[]} the folders of our other apps (the oap_* folder whose package.json names it) */
function ourAppDirs() {
  /** @type {string[]} */
  const dirs = [];
  let all = [];
  try {
    all = fs.readdirSync(OAP);
  } catch (e) {
    return dirs;
  }
  all.forEach((d) => {
    const pkg = read(path.join(OAP, d, "source", "package.json"));
    if (!pkg) return;
    OUR_APPS.forEach((name) => {
      if (pkg.indexOf('"name": "' + name + '"') >= 0 || pkg.indexOf('"name":"' + name + '"') >= 0) dirs.push(path.join(OAP, d));
    });
  });
  return dirs;
}

/**
 * Ticks (user + system) of each of our processes now, by pid.
 * @param {string[]} appDirs
 * @returns {Record<string, number>}
 */
function ourTicks(appDirs) {
  /** @type {Record<string, number>} */
  const out = {};
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch (e) {
    return out;
  }
  pids.forEach((pid) => {
    const stat = read("/proc/" + pid + "/stat");
    if (!stat) return;
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    let ours = Number(pid) === process.pid || OUR_PROGRAMS.some((n) => comm.indexOf(n.slice(0, 15)) === 0);
    if (!ours && comm === "node" && appDirs.length) {
      const cmd = read("/proc/" + pid + "/cmdline") || "";
      ours = appDirs.some((d) => cmd.indexOf(d) >= 0);
    }
    if (!ours) return;
    const f = stat.slice(close + 2).split(" ");
    out[pid] = Number(f[11]) + Number(f[12]); // utime, stime (fields 14 and 15)
  });
  return out;
}

/** @returns {?number} the processor's package temperature, deg C (coretemp's "Package id 0", else its first input) */
function packageTemp() {
  let hw = [];
  try {
    hw = fs.readdirSync(HWMON);
  } catch (e) {
    return null;
  }
  for (let i = 0; i < hw.length; i++) {
    const dir = path.join(HWMON, hw[i]);
    if ((read(path.join(dir, "name")) || "").trim() !== "coretemp") continue;
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    const inputs = files.filter((f) => /^temp\d+_input$/.test(f)).sort();
    const pkg = inputs.filter((f) => /^Package/.test(read(path.join(dir, f.replace("_input", "_label"))) || ""))[0] || inputs[0];
    const v = pkg ? Number(read(path.join(dir, pkg))) : NaN;
    if (isFinite(v)) return v / 1000;
  }
  return null;
}

/**
 * Samples: each call gives the CPU since the last one. The first call gives none (no window yet).
 */
class Usage {
  constructor() {
    /** @type {?{ busy: number, total: number, cores: number }} */
    this.last = null;
    /** @type {Record<string, number>} */
    this.lastOurs = {};
    this.appDirs = ourAppDirs();
  }

  /**
   * @returns {{ cpu: ?number, ours: ?number, cores: number, temp: ?number }} % of all cores together over the window
   */
  sample() {
    const now = cpuTotals();
    const ours = ourTicks(this.appDirs);
    /** @type {?number} */
    let cpu = null;
    /** @type {?number} */
    let oursPct = null;
    if (now && this.last && now.total > this.last.total) {
      const span = now.total - this.last.total; // ticks of all cores together
      cpu = (100 * (now.busy - this.last.busy)) / span;
      let sum = 0;
      Object.keys(ours).forEach((pid) => {
        if (pid in this.lastOurs) sum += ours[pid] - this.lastOurs[pid];
      });
      // read a moment after the totals: never more than the whole
      oursPct = Math.min(cpu, (100 * sum) / span);
    }
    this.last = now;
    this.lastOurs = ours;
    return { cpu: cpu, ours: oursPct, cores: now ? now.cores : 0, temp: packageTemp() };
  }
}

/**
 * The page's row: "CPU 66% of 4 cores, ours 12%, 55 °C".
 * @param {{ cpu: ?number, ours: ?number, cores: number, temp: ?number }} s
 * @returns {string}
 */
function row(s) {
  const cpu =
    s.cpu == null
      ? s.cores
        ? "CPU measuring"
        : "CPU not readable here"
      : "CPU " + Math.round(s.cpu) + "% of " + s.cores + " cores, ours " + Math.round(s.ours || 0) + "%";
  return cpu + ", " + (s.temp == null ? "temperature not readable here" : Math.round(s.temp) + " °C");
}

module.exports = { Usage, row, cpuTotals, packageTemp };
