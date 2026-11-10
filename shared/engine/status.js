"use strict";
/**
 * The status row on the center screen and the detail line under it.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const fs = require("fs");
const { MODE_NAME } = require("../car/consts");
const { MODE_TEXT } = require("./consts");
const { THEMES } = require("../hud_themes");
const { mib } = require("./util");

module.exports = {
  /**
   * fn(text) whenever the status line changes.
   * @param {(text: string, detail: string) => void} fn
   * @returns {void}
   */
  onStatus(fn) {
    this.statusListeners.push(fn);
    if (this.lastStatus) fn(this.lastStatus, this.lastDetail || "");
  },

  /**
   * The status update in half a second (one for a burst of events).
   * @returns {void}
   */
  _statusSoon() {
    if (this._statusT) return;
    this._statusT = setTimeout(() => {
      this._statusT = null;
      this._guard("status", () => this._status());
    }, 500);
  },

  /**
   * ", 3 of 5 layers drawn (2 waiting: <reason>)" while some layers aren't shown; "" when all are. Counts layers, not widgets.
   * @returns {string}
   */
  _drawnNote() {
    const ts = this.targetState;
    // cluster-render's mapping guard turned this target off (two display restarts right after its mappings); it stays
    // off, even across reboots, until cluster-render's guard-reset as root (cluster-render README, the mapping guard;
    // the full command is in the log line above). The vendored client passes the flag since 0.1.13
    if (ts && ts.disabled)
      return ", off: cluster-render's guard disabled this display after 2 strikes (reset it as root: guard-reset)";
    if (ts && (ts.state === "waiting" || ts.state === "parked") && ts.holder) {
      // holder "none" is no BMW content: on iDrive 7 it is the cluster panel holding the scene id the HUD shares
      // ("scene id in use by another target"); a stock holder says which wait it is (a pop-up or guidance, or the slot)
      if (ts.holder === "foreign")
        return ", waiting: another app has this display";
      if (ts.holder === "stock")
        return (
          ", waiting: BMW is using this display" +
          (ts.reason && ts.reason !== "slot in use"
            ? " (" + ts.reason + ")"
            : "")
        );
      if (/scene id in use/.test(ts.reason || ""))
        return ", waiting: the cluster layout has the scene the HUD shares";
      return ", waiting" + (ts.reason ? ": " + ts.reason : "");
    }
    const refused = this.refused ? ", refused " + this.refused : "";
    const refs = this._layerRefs();
    if (!refs.length) return refused;
    let shown = 0,
      why = null,
      whyN = 0;
    refs.forEach((r) => {
      const st = this.layerStates.get(r.key);
      if (st && st.state === "shown") shown++;
      else if (st) {
        whyN++;
        if (!why) why = st.state + (st.reason ? ": " + st.reason : "");
      }
    });
    if (shown === refs.length || (!why && !shown)) return refused;
    return (
      ", " +
      shown +
      " of " +
      this._layerCount(refs.length) +
      " drawn" +
      (why ? " (" + whyN + " " + why + ")" : "") +
      refused
    );
  },

  /**
   * The status line: what is drawn now, or why nothing is.
   * @returns {string}
   */
  statusText() {
    if (!this.client.ready) {
      let there = false;
      try {
        there = fs.existsSync(this.socketPath);
      } catch (e) {
        /* treat as missing */
      }
      return there
        ? this.label + ": connecting to cluster-render"
        : this.label + " off: cluster-render is not installed or not running";
    }
    if (this.problem) return this.label + ": " + this.problem;
    const byMode = this.setting("byMode") === true;
    const mode = this._navSwitch()
      ? " (navigating)"
      : byMode
        ? this.driveMode
          ? " (" + MODE_NAME[this.driveMode] + ")"
          : " (drive mode not seen yet)"
        : "";
    const what = this.target === "panel" ? "cluster" : "HUD";
    if (this.activeName === "off" && this.modeOff)
      return (
        this.label +
        " off while " +
        MODE_TEXT[this.activeMode] +
        " shows" +
        mode
      );
    if (this.activeName === "off")
      return this.label + " off" + mode + ": BMW's own " + what + " shows";
    const name = this._layoutLabel(this.activeName);
    const d = this.car.data();
    const demo = d.demo ? ", demo data" : "";
    const conns = this._connCount();
    const layers =
      ", " +
      this._layerCount(this._layerRefs().length) +
      (conns > 1 ? " on " + conns + " connections" : "") +
      (this.pixelBytes
        ? ", " + mib(this.pixelBytes) + " of 16 MiB pixels"
        : "") +
      (this.activeMode !== "normal" ? ", " + this.activeMode + " mode" : "");
    if (this.layoutTheme)
      return this.label + " on" + mode + ": " + name + " theme" + layers + demo;
    const theme = THEMES[this.themeName]
      ? THEMES[this.themeName].name
      : this.themeName;
    const auto = this.setting("hudTheme") === "auto" ? " (Auto)" : "";
    return (
      this.label +
      " on" +
      mode +
      ": " +
      name +
      " layout, " +
      theme +
      " theme" +
      auto +
      layers +
      demo
    );
  },

  /** The status page's second row: why layers aren't drawn ("Waiting: BMW is using this display", "3 of 5 drawn (...)",
   *  "Refused ..."), "" when all is drawn or nothing shows.
   * @returns {string}
   */
  statusDetail() {
    if (!this.client.ready || this.problem || this.activeName === "off")
      return "";
    const n = this._drawnNote().replace(/^, /, "");
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : "";
  },

  /**
   * Tells the status listeners when the status changed.
   * @returns {void}
   */
  _status() {
    const s = this.statusText(),
      d = this.statusDetail();
    if (s === this.lastStatus && d === this.lastDetail) return;
    this.lastStatus = s;
    this.lastDetail = d;
    this.statusListeners.forEach((fn) => {
      try {
        fn(s, d);
      } catch (e) {
        this.log.warn("status listener: " + e);
      }
    });
  },
};
