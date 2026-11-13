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

const STATUS_SOON_MS = 500; // a burst of events waits this long for one status update

/**
 * The status row's state on the app (App, through app_type.d.ts).
 * @typedef {object} StatusState
 * @property {?ReturnType<typeof setTimeout>} [_statusT] a status update waiting (at most one at a time)
 * @property {string} [lastDetail] the detail line last shown
 */

// cluster-render's reason for a layer whose texture is still going up (compositor.cpp)
const UPLOADING = /asset it samples is not written yet/;

module.exports = /** @satisfies {ThisType<import("./app").App>} */ ({
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
    }, STATUS_SOON_MS);
  },

  /**
   * ", 3 of 5 layers drawn (2 waiting: <reason>)" while some layers aren't shown; "" when all are. Counts layers, not widgets.
   * @returns {string}
   */
  _drawnNote() {
    const targetState = this.targetState;
    // cluster-render's mapping guard turned this target off (two display restarts right after its mappings); it stays
    // off, even across reboots, until cluster-render's guard-reset as root (cluster-render README, the mapping guard;
    // the full command is in the log line above). The vendored client passes the flag since 0.1.13
    if (targetState && targetState.disabled)
      return ", off: cluster-render's guard disabled this display after 2 strikes (reset it as root: guard-reset)";
    if (
      targetState &&
      (targetState.state === "waiting" || targetState.state === "parked") &&
      targetState.holder
    ) {
      // holder "none" is no BMW content: on iDrive 7 it is the cluster panel holding the scene id the HUD shares
      // ("scene id in use by another target"); a stock holder says which wait it is (a pop-up or guidance, or the slot)
      if (targetState.holder === "foreign")
        return ", waiting: another app has this display";
      if (targetState.holder === "stock")
        return (
          ", waiting: BMW is using this display" +
          (targetState.reason && targetState.reason !== "slot in use"
            ? " (" + targetState.reason + ")"
            : "")
        );
      if (/scene id in use/.test(targetState.reason || ""))
        return ", waiting: the cluster layout has the scene the HUD shares";
      return (
        ", waiting" + (targetState.reason ? ": " + targetState.reason : "")
      );
    }
    const refused = this.refused ? ", refused " + this.refused : "";
    const refs = this._layerRefs();
    if (!refs.length) return refused;
    let shown = 0,
      /** @type {?string} */
      why = null,
      whyN = 0,
      loading = 0;
    refs.forEach((layerRef) => {
      const layerState = this.layerStates.get(layerRef.key);
      if (layerState && layerState.state === "shown") shown++;
      else if (layerState) {
        whyN++;
        if (layerState.state === "waiting" && UPLOADING.test(layerState.reason || "")) loading++;
        if (!why)
          why =
            layerState.state +
            (layerState.reason ? ": " + layerState.reason : "");
      }
    });
    if (shown === refs.length || (!why && !shown)) return refused;
    // every layer not drawn yet waits for a texture still going up (the atlases, a backdrop: about 5.6 MB a second
    // after a scene comes back, so a few seconds for big ones): loading
    if (loading === whyN)
      return ", loading (" + shown + " of " + this._layerCount(refs.length) + " drawn)" + refused;
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
      } catch (err) {
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
    const data = this.car.data();
    const demo = data.demo ? ", demo data" : "";
    const conns = this._connCount();
    const layers =
      ", " +
      this._layerCount(this._layerRefs().length) +
      (conns > 1 ? " on " + conns + " connections" : "") +
      (this.pixelBytes
        ? ", " + mib(this.pixelBytes) + " of 32 MiB pixels"
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
    const note = this._drawnNote().replace(/^, /, "");
    return note ? note.charAt(0).toUpperCase() + note.slice(1) : "";
  },

  /**
   * Tells the status listeners when the status changed.
   * @returns {void}
   */
  _status() {
    const text = this.statusText(),
      detail = this.statusDetail();
    if (text === this.lastStatus && detail === this.lastDetail) return;
    this.lastStatus = text;
    this.lastDetail = detail;
    this.statusListeners.forEach((fn) => {
      try {
        fn(text, detail);
      } catch (err) {
        this.log.warn("status listener: " + err);
      }
    });
  },
});
