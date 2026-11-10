"use strict";
/**
 * Which layout shows (the settings, the drive mode, BMW's guidance), the HUD mode (cruise, nav), the
 * colour theme, a widget's "toggle" and its map "hole".
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const sun = require("../sun");
const { MODE_KEY } = require("./consts");
const { isNum } = require("./util");

/** @typedef {import("./app").Widget} Widget */

module.exports = {
  /**
   * HUD modes only on the HUD, in apps that have the "makeRoom" setting.
   * @returns {boolean}
   */
  _modesOn() {
    return this.target === "hud" && !!this.ctx.settings.item("makeRoom");
  },

  /**
   * The HUD mode now: normal, cruise, nav or cruiseNav (see the header).
   * @returns {string}
   */
  _mode() {
    if (!this._modesOn() || this.setting("makeRoom") !== true) return "normal";
    return this.navActive
      ? this.assistActive
        ? "cruiseNav"
        : "nav"
      : this.assistActive
        ? "cruise"
        : "normal";
  },

  /**
   * Rebuilds when the HUD mode changed.
   * @returns {void}
   */
  _modeChanged() {
    const m = this._mode();
    if (m === this.activeMode) return;
    this.log.info("HUD mode " + m);
    this._rebuild();
  },

  /**
   * A widget as it is in a mode: its "in"[mode] fields over its own, or null when that is false.
   * @param {Widget} w
   * @param {string} mode
   * @returns {?Widget}
   */
  _inMode(w, mode) {
    if (!w.in || !Object.prototype.hasOwnProperty.call(w.in, mode)) return w;
    const o = w.in[mode];
    return o === false ? null : Object.assign({}, w, o);
  },

  /**
   * The "navLayout" switch is in force: the app has that setting (the cluster), it names a layout, and BMW is guiding.
   * @returns {boolean}
   */
  _navSwitch() {
    if (!this.navActive || !this.ctx.settings.item("navLayout")) return false;
    const v = this.setting("navLayout");
    return !!v && v !== "same";
  },

  /** The layout name to show now: the "navLayout" one while guiding, else per drive mode when that's on and known (apps
   *  with "byMode"), else the plain setting.
   * @returns {string}
   */
  _layoutName() {
    if (this._navSwitch()) return this.setting("navLayout");
    if (
      this.setting("byMode") === true &&
      this.driveMode &&
      MODE_KEY[this.driveMode]
    ) {
      const v = this.setting(MODE_KEY[this.driveMode]);
      if (v) return v;
    }
    return this.setting("hudLayout");
  },

  /**
   * A layout's name as the "hudLayout" setting shows it.
   * @param {string} name
   * @returns {string}
   */
  _layoutLabel(name) {
    const lay = this.ctx.settings.item("hudLayout");
    const o = lay && (lay.options || []).find((x) => x[0] === name);
    return o ? o[1] : name;
  },

  /**
   * The theme now: the layout's own, else "hudTheme" (Auto: Night after
   * sunset).
   * @returns {string}
   */
  _themeName() {
    if (this.layoutTheme) return this.layoutTheme;
    const t = this.setting("hudTheme");
    if (t !== "auto") return t;
    return sun.isNight(Date.now(), this.location.lat, this.location.lon)
      ? "night"
      : this.setting("dayTheme");
  },

  /**
   * "key" is on while that bool setting is on; "!key" while it is off.
   * @param {string} t
   * @returns {boolean}
   */
  _toggleOn(t) {
    const not = t.charAt(0) === "!";
    const k = not ? t.slice(1) : t,
      eq = k.indexOf("=");
    const on =
      eq > 0
        ? String(this.setting(k.slice(0, eq))) === k.slice(eq + 1)
        : this.setting(k) !== false;
    return not ? !on : on;
  },

  /**
   * A widget's map hole in layer px, inset by "holeInset" (6) a side, while "holeWhen" is on; else no hole.
   * @param {Widget} w
   * @returns {number[]} [x, y, w, h]
   */
  _hole(w) {
    const h =
      w.hole && w.holeWhen && this.setting(w.holeWhen) === true ? w.hole : null;
    if (!h) return [0, 0, 0, 0];
    const inset = isNum(w.holeInset) ? w.holeInset : 6;
    return [
      h[0] + inset - w.x,
      h[1] + inset - w.y,
      Math.max(0, h[2] - 2 * inset),
      Math.max(0, h[3] - 2 * inset),
    ];
  },

  /**
   * A widget's map hole corner radius, px ("holeRadius", 28).
   * @param {Widget} w
   * @returns {number}
   */
  _holeRadius(w) {
    return isNum(w.holeRadius) ? w.holeRadius : 28;
  },
};
