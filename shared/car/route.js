"use strict";
/**
 * BMW's route guidance: the distance and time left, the route's progress.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const { GUIDANCE_STATE, enumNum } = require("./consts");
const { isNum } = require("../engine/util");

/** @typedef {import("./consts").Route} Route */

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /**
   * finalDestinationInfo: distance left (formattedDistance: BMW's text, its unit, rawDistance), time left (travelTime, s).
   * @param {*} v
   * @returns {void}
   */
  _onRouteInfo(v) {
    if (!v || typeof v !== "object") return;
    const fd = v.formattedDistance || {};
    const raw = isNum(fd.rawDistance)
      ? fd.rawDistance
      : isNum(v.distanceFromCurrentToFinalDestination)
        ? v.distanceFromCurrentToFinalDestination
        : null;
    this.route = Object.assign(this.route || {}, {
      leftRaw: raw,
      leftText: typeof fd.distance === "string" ? fd.distance.trim() : null,
      leftUnit: fd.unit,
      timeLeft:
        isNum(v.travelTime) && v.travelTime >= 0 && v.travelTime < 0xffffffff
          ? v.travelTime
          : null,
      at: Date.now(),
    });
    // without a travelled distance, the route's length is the most left seen since guidance started
    if (isNum(raw))
      this.route.startRaw = Math.max(this.route.startRaw || 0, raw);
    this._logRoute("destination", {
      distance: fd,
      travelTime: v.travelTime,
      delayTime: v.delayTime,
      delayStatus: v.delayStatus,
      distanceFromCurrentToFinalDestination:
        v.distanceFromCurrentToFinalDestination,
    });
  },

  /**
   * travelledDistance (FormattedDistance): how far along the route we are, for the bar's total (travelled + left).
   * @param {*} v
   * @returns {void}
   */
  _onTravelled(v) {
    if (!v || typeof v !== "object") return;
    this.route = Object.assign(this.route || {}, {
      doneRaw: isNum(v.rawDistance) ? v.rawDistance : null,
    });
    this._logRoute("travelled", v);
  },

  /**
   * Route messages as sent, each when it changes, at most every 10 s (to confirm the units on the car).
   * @param {string} kind
   * @param {*} v
   * @returns {void}
   */
  _logRoute(kind, v) {
    const now = Date.now(),
      line = JSON.stringify(v);
    this.routeLogged = this.routeLogged || {};
    this.routeLogAt = this.routeLogAt || {};
    if (
      line === this.routeLogged[kind] ||
      now - (this.routeLogAt[kind] || 0) < 10000
    )
      return;
    this.routeLogged[kind] = line;
    this.routeLogAt[kind] = now;
    this.log.info("route " + kind + " raw " + line);
  },

  /** The route's progress 0..1 (travelled / (travelled + left), else 1 - left / the most left seen), null when not guiding
   *  or not known.
   * @returns {?number}
   */
  _routeProgress() {
    const r = this.route;
    if (!this.navActive || !r || !isNum(r.leftRaw)) return null;
    if (isNum(r.doneRaw) && r.doneRaw + r.leftRaw > 0)
      return Math.min(1, Math.max(0, r.doneRaw / (r.doneRaw + r.leftRaw)));
    return r.startRaw > 0
      ? Math.min(1, Math.max(0, 1 - r.leftRaw / r.startRaw))
      : null;
  },

  /**
   * guidanceState: INACTIVE 0, CALCULATING_ROUTE 1, ACTIVE 2 (the car's catalog), by name or number; anything else reads as off.
   * @param {*} raw
   * @returns {void}
   */
  _onGuidance(raw) {
    const v = raw && typeof raw === "object" ? raw.guidanceState : raw;
    if (String(v) !== String(this.navRaw)) {
      this.navRaw = v;
      this.log.info("route guidance state " + JSON.stringify(raw));
    }
    const on =
      enumNum(typeof v === "string" ? v.toUpperCase() : v, GUIDANCE_STATE) ===
      GUIDANCE_STATE.ACTIVE;
    if (on === this.navActive) return;
    this.navActive = on;
    if (on) this.route = null; // a new route: its length starts over
    if (
      this.ctx.settings.item("navLayout") &&
      this._layoutName() !== this.activeName
    ) {
      this.log.info(
        "route guidance " +
          (on ? "on" : "off") +
          ": layout " +
          this._layoutName(),
      );
      this._rebuild();
      return;
    }
    this._modeChanged();
  },
});
