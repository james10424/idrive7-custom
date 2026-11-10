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
  STA_WHEEL,
  enumNum,
} = require("./consts");
const { isNum } = require("../engine/util");

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /**
   * functionalLibraryData: BMW's HUD shows its driver assistance block while it has the assist symbol (ldmSym
   * with a colour), the ACC car or distance bars, or a lit (not grey) lane-assist wheel.
   * @param {*} v
   * @returns {void}
   */
  _onAssist(v) {
    if (!v || typeof v !== "object") return;
    const acc = v.activeCruiseControl || {},
      sta = v.trafficJamAssist || {};
    const sym = enumNum(v.ldmSym, LDM_SYM),
      col = enumNum(v.ldmSymColor, LDM_COLOR);
    const car = enumNum(acc.symbolACC, ACC_SYM),
      bars = enumNum(acc.barsColorACC, ACC_BARS);
    const wheel = enumNum(sta.steeringWheel, STA_WHEEL);
    this.accSetRaw = isNum(v.cruiseCtrlSpeedHUD) ? v.cruiseCtrlSpeedHUD : null;
    const raw = [
      v.ldmSym,
      v.ldmSymColor,
      acc.symbolACC,
      acc.barsColorACC,
      sta.steeringWheel,
    ].join(" ");
    if (raw !== this.assistRaw) {
      this.assistRaw = raw;
      this.log.info(
        "driver assistance on the HUD: symbol " +
          v.ldmSym +
          " " +
          v.ldmSymColor +
          ", ACC " +
          acc.symbolACC +
          " " +
          acc.barsColorACC +
          ", wheel " +
          sta.steeringWheel,
      );
    }
    this.accOn = !!car || !!bars;
    const on =
      (!!sym && !!col) ||
      !!car ||
      !!bars ||
      (!!wheel && wheel !== STA_WHEEL.LDM_STW_GREY);
    if (on === this.assistActive) return;
    this.assistActive = on;
    this._modeChanged();
  },

  /** The car-ahead messages as sent, when they change (an X3 repeats the same one every second), at most once a second,
   *  for calibrating config.acc against what BMW's HUD shows.
   * @param {string} kind
   * @param {*} v
   * @returns {void}
   */
  _logAhead(kind, v) {
    const now = Date.now(),
      line = JSON.stringify(v);
    this.aheadLogged = this.aheadLogged || {};
    this.aheadLogAt = this.aheadLogAt || {};
    if (
      line === this.aheadLogged[kind] ||
      now - (this.aheadLogAt[kind] || 0) < 1000
    )
      return; // each message on its own
    this.aheadLogged[kind] = line;
    this.aheadLogAt[kind] = now;
    this.log.info(
      "car ahead raw: " +
        line +
        (isNum(this.accSetRaw) && this.accSetRaw !== 65535
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
    const c = (this.config.acc && this.config.acc[key]) || {};
    return (
      raw * (isNum(c.factor) ? c.factor : 1) + (isNum(c.offset) ? c.offset : 0)
    );
  },

  /**
   * The gap in m: DataFrontVehicle's while it is fresh and available, else GapVehicleDrivingAhead's while a car is measured.
   * @returns {?number}
   */
  _gapM() {
    const now = Date.now(),
      a = this.ahead,
      b = this.ahead2;
    if (
      a &&
      now - a.at < FRESH_MS &&
      enumNum(a.q, AHEAD_Q) !== AHEAD_Q.EVENT_DATA_NOT_AVAILABLE &&
      isNum(a.gapX)
    )
      return this._accScale("gap", a.gapX);
    if (
      b &&
      now - b.at < FRESH_MS &&
      b.measured &&
      isNum(b.gap) &&
      [6, 14, 15].indexOf(enumNum(b.q, AHEAD2_Q)) < 0
    )
      return this._accScale("gap", b.gap);
    return null;
  },

  /**
   * The relative speed from the gap's rate of change (km/h, minus = closing), smoothed over REL_TAU_MS; reset without a gap.
   * @returns {void}
   */
  _gapRate() {
    const now = Date.now(),
      g = this._gapM(),
      r = this.relFromGap;
    if (!isNum(g)) {
      this.relFromGap = null;
      return;
    }
    if (!r) {
      this.relFromGap = { v: null, gapM: g, at: now };
      return;
    }
    const dt = now - r.at;
    if (dt < 200) return;
    const inst = ((g - r.gapM) / (dt / 1000)) * 3.6;
    const k = 1 - Math.exp(-dt / REL_TAU_MS);
    this.relFromGap = {
      v: isNum(r.v) ? r.v + (inst - r.v) * k : inst,
      gapM: g,
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
      a = this.ahead;
    if (key === "gap") return this._gapM();
    if (key === "rel") {
      const own = this._raw("speed");
      if (!isNum(own) || own < 1) return null; // standing still: "--" (the gap's rate is only noise then)
      // DataFrontVehicle's speed only once config.acc.rel says how to read it (use: true): following a car slowly on an
      // X3 it read 509, not a relative km/h; until then the gap's rate
      const cr = (this.config.acc && this.config.acc.rel) || {};
      if (
        cr.use === true &&
        a &&
        now - a.at < FRESH_MS &&
        enumNum(a.q, AHEAD_Q) !== AHEAD_Q.EVENT_DATA_NOT_AVAILABLE &&
        isNum(a.speedX)
      )
        return this._accScale("rel", a.speedX);
      const r = this.relFromGap;
      return r && isNum(r.v) && now - r.at < FRESH_MS && isNum(this._gapM())
        ? r.v
        : null;
    }
    if (key === "set")
      return this.assistActive &&
        isNum(this.accSetRaw) &&
        this.accSetRaw !== 65535
        ? this._accScale("set", this.accSetRaw)
        : null;
    return null;
  },

  /**
   * The car ahead getting closer faster than config.acc.closingKmh (10 km/h).
   * @returns {boolean}
   */
  _closing() {
    const r = this._acc("rel"),
      lim =
        this.config.acc && isNum(this.config.acc.closingKmh)
          ? this.config.acc.closingKmh
          : 10;
    return isNum(r) && r < -lim;
  },
});
