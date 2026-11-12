"use strict";
/**
 * Which layout shows (the settings, the drive mode, BMW's guidance), the HUD mode (cruise, nav), the
 * colour theme, a widget's "toggle" and its map "hole".
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const sun = require("../sun");
const { MODE_KEY } = require("./consts");
const { isNum } = require("./util");

const HOLE_INSET_PX = 6; // a map hole's default inset ("holeInset")
const HOLE_RADIUS_PX = 28; // a map hole's default corner radius ("holeRadius")

/** @typedef {import("./app").Widget} Widget */

module.exports = /** @satisfies {ThisType<import("./app").App>} */ ({
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
    const mode = this._mode();
    if (mode === this.activeMode) return;
    this.log.info("HUD mode " + mode);
    this._rebuild();
  },

  /**
   * A widget as it is in a mode: its "in"[mode] fields over its own, or null when that is false.
   * @param {Widget} widget
   * @param {string} mode
   * @returns {?Widget}
   */
  _inMode(widget, mode) {
    if (!widget.in || !Object.prototype.hasOwnProperty.call(widget.in, mode))
      return widget;
    const override = widget.in[mode];
    return override === false ? null : Object.assign({}, widget, override);
  },

  /**
   * The "navLayout" switch is in force: the app has that setting (the cluster), it names a layout, and BMW is guiding.
   * @returns {boolean}
   */
  _navSwitch() {
    if (!this.navActive || !this.ctx.settings.item("navLayout")) return false;
    const value = this.setting("navLayout");
    return !!value && value !== "same";
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
      const value = this.setting(MODE_KEY[this.driveMode]);
      if (value) return value;
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
    const option = lay && (lay.options || []).find((opt) => opt[0] === name);
    return option ? option[1] : name;
  },

  /**
   * The theme now: the layout's own, else "hudTheme" (Auto: Night after
   * sunset).
   * @returns {string}
   */
  _themeName() {
    if (this.layoutTheme) return this.layoutTheme;
    const theme = this.setting("hudTheme");
    if (theme !== "auto") return theme;
    return sun.isNight(Date.now(), this.location.lat, this.location.lon)
      ? "night"
      : this.setting("dayTheme");
  },

  /**
   * "key" is on while that bool setting is on; "!key" while it is off.
   * @param {string} toggle
   * @returns {boolean}
   */
  _toggleOn(toggle) {
    const not = toggle.charAt(0) === "!";
    const k = not ? toggle.slice(1) : toggle,
      eqAt = k.indexOf("=");
    const isOn =
      eqAt > 0
        ? String(this.setting(k.slice(0, eqAt))) === k.slice(eqAt + 1)
        : this.setting(k) !== false;
    return not ? !isOn : isOn;
  },

  /**
   * A widget's map hole in layer px, inset by "holeInset" (6) a side, while "holeWhen" is on; else no hole.
   * @param {Widget} widget
   * @returns {number[]} [x, y, w, h]
   */
  _hole(widget) {
    const hole =
      widget.hole && widget.holeWhen && this.setting(widget.holeWhen) === true
        ? widget.hole
        : null;
    if (!hole) return [0, 0, 0, 0];
    const inset = isNum(widget.holeInset) ? widget.holeInset : HOLE_INSET_PX;
    return [
      hole[0] + inset - widget.x,
      hole[1] + inset - widget.y,
      Math.max(0, hole[2] - 2 * inset),
      Math.max(0, hole[3] - 2 * inset),
    ];
  },

  /**
   * A widget's map hole corner radius, px ("holeRadius", 28).
   * @param {Widget} widget
   * @returns {number}
   */
  _holeRadius(widget) {
    return isNum(widget.holeRadius) ? widget.holeRadius : HOLE_RADIUS_PX;
  },
});
