"use strict";
/**
 * BMW's route guidance: the distance and time left, the route's progress.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const { GUIDANCE_STATE, enumNum } = require("./consts");
const { isNum } = require("../engine/util");

const TRAVEL_TIME_NONE = 0xffffffff; // Guidance travelTime: not known
const ROUTE_LOG_MS = 10000; // route messages: logged at most this often per kind

/** @typedef {import("./consts").Route} Route */

/**
 * The route on the app (App, through app_type.d.ts).
 * @typedef {object} RouteState
 * @property {?Route} [route] while guiding, raw distances; null when a new route starts
 * @property {Record<string, string>} [routeLogged] the route messages last logged, by kind
 * @property {Record<string, number>} [routeLogAt]
 */

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /**
   * finalDestinationInfo: distance left (formattedDistance: BMW's text, its unit, rawDistance), time left (travelTime, s).
   * @param {import("./someip").Fields["de.bmw.infotainment.navigation.guiding.Guidance"]["finalDestinationInfo"]} msg
   * @returns {void}
   */
  _onRouteInfo(msg) {
    if (!msg || typeof msg !== "object") return;
    const formatted = msg.formattedDistance || {};
    const raw = isNum(formatted.rawDistance)
      ? formatted.rawDistance
      : isNum(msg.distanceFromCurrentToFinalDestination)
        ? msg.distanceFromCurrentToFinalDestination
        : null;
    this.route = Object.assign(this.route || {}, {
      leftRaw: raw,
      leftText:
        typeof formatted.distance === "string"
          ? formatted.distance.trim()
          : null,
      leftUnit: formatted.unit,
      timeLeft:
        isNum(msg.travelTime) &&
        msg.travelTime >= 0 &&
        msg.travelTime < TRAVEL_TIME_NONE
          ? msg.travelTime
          : null,
      at: Date.now(),
    });
    // without a travelled distance, the route's length is the most left seen since guidance started
    if (isNum(raw))
      this.route.startRaw = Math.max(this.route.startRaw || 0, raw);
    this._logRoute("destination", {
      distance: formatted,
      travelTime: msg.travelTime,
      delayTime: msg.delayTime,
      delayStatus: msg.delayStatus,
      distanceFromCurrentToFinalDestination:
        msg.distanceFromCurrentToFinalDestination,
    });
  },

  /**
   * travelledDistance (FormattedDistance): how far along the route we are, for the bar's total (travelled + left).
   * @param {import("./someip").Fields["de.bmw.infotainment.navigation.guiding.Guidance"]["travelledDistance"]} msg
   * @returns {void}
   */
  _onTravelled(msg) {
    if (!msg || typeof msg !== "object") return;
    this.route = Object.assign(this.route || {}, {
      doneRaw: isNum(msg.rawDistance) ? msg.rawDistance : null,
    });
    this._logRoute("travelled", msg);
  },

  /**
   * Route messages as sent, each when it changes, at most every 10 s (to confirm the units on the car).
   * @param {string} kind
   * @param {unknown} msg
   * @returns {void}
   */
  _logRoute(kind, msg) {
    const now = Date.now(),
      line = JSON.stringify(msg);
    this.routeLogged = this.routeLogged || {};
    this.routeLogAt = this.routeLogAt || {};
    if (
      line === this.routeLogged[kind] ||
      now - (this.routeLogAt[kind] || 0) < ROUTE_LOG_MS
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
    const route = this.route;
    if (!this.navActive || !route || !isNum(route.leftRaw)) return null;
    if (isNum(route.doneRaw) && route.doneRaw + route.leftRaw > 0)
      return Math.min(
        1,
        Math.max(0, route.doneRaw / (route.doneRaw + route.leftRaw)),
      );
    return route.startRaw > 0
      ? Math.min(1, Math.max(0, 1 - route.leftRaw / route.startRaw))
      : null;
  },

  /**
   * guidanceState: INACTIVE 0, CALCULATING_ROUTE 1, ACTIVE 2 (the car's catalog), by name or number; anything else reads as off.
   * @param {import("./someip").Fields["de.bmw.infotainment.navigation.guiding.Guidance"]["guidanceState"] | { guidanceState?: import("./someip").Fields["de.bmw.infotainment.navigation.guiding.Guidance"]["guidanceState"] }} raw the field, or a struct holding it
   * @returns {void}
   */
  _onGuidance(raw) {
    const state = raw && typeof raw === "object" ? raw.guidanceState : raw;
    if (String(state) !== String(this.navRaw)) {
      this.navRaw = state;
      this.log.info("route guidance state " + JSON.stringify(raw));
    }
    const active =
      enumNum(
        typeof state === "string" ? state.toUpperCase() : state,
        GUIDANCE_STATE,
      ) === GUIDANCE_STATE.ACTIVE;
    if (active === this.navActive) return;
    this.navActive = active;
    if (active) this.route = null; // a new route: its length starts over
    if (
      this.ctx.settings.item("navLayout") &&
      this._layoutName() !== this.activeName
    ) {
      this.log.info(
        "route guidance " +
          (active ? "on" : "off") +
          ": layout " +
          this._layoutName(),
      );
      this._rebuild();
      return;
    }
    this._modeChanged();
  },
});
