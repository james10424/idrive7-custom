"use strict";
/**
 * Driver assistance (what BMW's HUD shows of ACC, DCC, STA) and the car ahead.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const {
  ACC_BARS,
  ACC_SYM,
  AHEAD2_Q,
  AHEAD_Q,
  FRESH_MS,
  LDM_COLOR,
  LDM_SYM,
  REL_TAU_MS,
  STANDSTILL_KMH,
  STA_WHEEL,
  enumNum,
} = require("./consts");
const { isNum } = require("../engine/util");

const AHEAD_LOG_MS = 1000; // the car ahead's raw messages: logged at most this often per kind
const ACC_SET_NONE = 65535; // cruiseCtrlSpeedHUD: no set speed
const REL_MIN_DT_MS = 200; // the gap's rate: worked out over at least this long
const KMH_PER_MS = 3.6;
const CLOSING_KMH = 10; // config.acc.closingKmh when unset

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /**
   * functionalLibraryData: BMW's HUD shows its driver assistance block while it has the assist symbol (ldmSym
   * with a colour), the ACC car or distance bars, or a lit (not grey) lane-assist wheel.
   * @param {import("./someip").Fields["de.bmw.infotainment.displaydataserver.DisplayDataServer"]["functionalLibraryData"]} msg
   * @returns {void}
   */
  _onAssist(msg) {
    if (!msg || typeof msg !== "object") return;
    const acc = msg.activeCruiseControl || {},
      sta = msg.trafficJamAssist || {};
    const sym = enumNum(msg.ldmSym, LDM_SYM),
      col = enumNum(msg.ldmSymColor, LDM_COLOR);
    const car = enumNum(acc.symbolACC, ACC_SYM),
      bars = enumNum(acc.barsColorACC, ACC_BARS);
    const wheel = enumNum(sta.steeringWheel, STA_WHEEL);
    this.accSetRaw = isNum(msg.cruiseCtrlSpeedHUD)
      ? msg.cruiseCtrlSpeedHUD
      : null;
    const raw = [
      msg.ldmSym,
      msg.ldmSymColor,
      acc.symbolACC,
      acc.barsColorACC,
      sta.steeringWheel,
    ].join(" ");
    if (raw !== this.assistRaw) {
      this.assistRaw = raw;
      this.log.info(
        "driver assistance on the HUD: symbol " +
          msg.ldmSym +
          " " +
          msg.ldmSymColor +
          ", ACC " +
          acc.symbolACC +
          " " +
          acc.barsColorACC +
          ", wheel " +
          sta.steeringWheel,
      );
    }
    this.accOn = !!car || !!bars;
    const active =
      (!!sym && !!col) ||
      !!car ||
      !!bars ||
      (!!wheel && wheel !== STA_WHEEL.LDM_STW_GREY);
    if (active === this.assistActive) return;
    this.assistActive = active;
    this._modeChanged();
  },

  /** The car-ahead messages as sent, when they change (an X3 repeats the same one every second), at most once a second,
   *  for calibrating config.acc against what BMW's HUD shows.
   * @param {string} kind
   * @param {unknown} msg
   * @returns {void}
   */
  _logAhead(kind, msg) {
    const now = Date.now(),
      line = JSON.stringify(msg);
    this.aheadLogged = this.aheadLogged || {};
    this.aheadLogAt = this.aheadLogAt || {};
    if (
      line === this.aheadLogged[kind] ||
      now - (this.aheadLogAt[kind] || 0) < AHEAD_LOG_MS
    )
      return; // each message on its own
    this.aheadLogged[kind] = line;
    this.aheadLogAt[kind] = now;
    this.log.info(
      "car ahead raw: " +
        line +
        (isNum(this.accSetRaw) && this.accSetRaw !== ACC_SET_NONE
          ? ", set speed " + this.accSetRaw
          : "") +
        ", speed " +
        this._token("speed"),
    );
  },

  /**
   * raw * factor + offset from config.acc[key].
   * @param {string} key gap, rel or set
   * @param {number} raw
   * @returns {number}
   */
  _accScale(key, raw) {
    const scale = (this.config.acc && this.config.acc[key]) || {};
    return (
      raw * (isNum(scale.factor) ? scale.factor : 1) +
      (isNum(scale.offset) ? scale.offset : 0)
    );
  },

  /**
   * The gap in m: DataFrontVehicle's while it is fresh and available, else GapVehicleDrivingAhead's while a car is measured.
   * @returns {?number}
   */
  _gapM() {
    const now = Date.now(),
      ahead = this.ahead,
      ahead2 = this.ahead2;
    if (
      ahead &&
      now - ahead.at < FRESH_MS &&
      enumNum(ahead.q, AHEAD_Q) !== AHEAD_Q.EVENT_DATA_NOT_AVAILABLE &&
      isNum(ahead.gapX)
    )
      return this._accScale("gap", ahead.gapX);
    if (
      ahead2 &&
      now - ahead2.at < FRESH_MS &&
      ahead2.measured &&
      isNum(ahead2.gap) &&
      [
        AHEAD2_Q.FUNKTION_MELDET_FEHLER,
        AHEAD2_Q.FUNKTION_NICHT_VERFUEGBAR,
        AHEAD2_Q.SIGNAL_UNBEFUELLT,
      ].indexOf(enumNum(ahead2.q, AHEAD2_Q)) < 0
    )
      return this._accScale("gap", ahead2.gap);
    return null;
  },

  /**
   * The relative speed from the gap's rate of change (km/h, minus = closing), smoothed over REL_TAU_MS; reset without a gap.
   * @returns {void}
   */
  _gapRate() {
    const now = Date.now(),
      gapM = this._gapM(),
      prev = this.relFromGap;
    if (!isNum(gapM)) {
      this.relFromGap = null;
      return;
    }
    if (!prev) {
      this.relFromGap = { v: null, gapM: gapM, at: now };
      return;
    }
    const dt = now - prev.at;
    if (dt < REL_MIN_DT_MS) return;
    const inst = ((gapM - prev.gapM) / (dt / 1000)) * KMH_PER_MS;
    const k = 1 - Math.exp(-dt / REL_TAU_MS);
    this.relFromGap = {
      v: isNum(prev.v) ? prev.v + (inst - prev.v) * k : inst,
      gapM: gapM,
      at: now,
    };
  },

  /**
   * An ACC value: 'gap' m, 'rel' km/h (DataFrontVehicle's speed when sent, else the gap's rate), 'set'; null when missing or stale.
   * @param {string} key gap, rel or set
   * @returns {?number}
   */
  _acc(key) {
    const now = Date.now(),
      ahead = this.ahead;
    if (key === "gap") return this._gapM();
    if (key === "rel") {
      const own = this._raw("speed");
      if (!isNum(own) || own < STANDSTILL_KMH) return null; // standing still: "--" (the gap's rate is only noise then)
      // DataFrontVehicle's speed only once config.acc.rel says how to read it (use: true): following a car slowly on an
      // X3 it read 509, not a relative km/h; until then the gap's rate
      const relCfg = (this.config.acc && this.config.acc.rel) || {};
      if (
        relCfg.use === true &&
        ahead &&
        now - ahead.at < FRESH_MS &&
        enumNum(ahead.q, AHEAD_Q) !== AHEAD_Q.EVENT_DATA_NOT_AVAILABLE &&
        isNum(ahead.speedX)
      )
        return this._accScale("rel", ahead.speedX);
      const fromGap = this.relFromGap;
      return fromGap &&
        isNum(fromGap.v) &&
        now - fromGap.at < FRESH_MS &&
        isNum(this._gapM())
        ? fromGap.v
        : null;
    }
    if (key === "set")
      return this.assistActive &&
        isNum(this.accSetRaw) &&
        this.accSetRaw !== ACC_SET_NONE
        ? this._accScale("set", this.accSetRaw)
        : null;
    return null;
  },

  /**
   * The car ahead getting closer faster than config.acc.closingKmh (10 km/h).
   * @returns {boolean}
   */
  _closing() {
    const rel = this._acc("rel"),
      lim =
        this.config.acc && isNum(this.config.acc.closingKmh)
          ? this.config.acc.closingKmh
          : CLOSING_KMH;
    return isNum(rel) && rel < -lim;
  },
});
