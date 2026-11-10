"use strict";
/**
 * Lamps: the parking brake / Auto Hold, the indicators, cruise, and the gear row's lit slot.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const { REGAL_GEARS } = require("./consts");
const { isNum } = require("../engine/util");

module.exports = {
  /** The Regal lamps. Brake: the brake lights (the demo drive: while slowing). Turn: blinking at 1.25 Hz while the car says
   *  that side (hazards: both); the demo drive blinks left now and then. Cruise: BMW's ACC car or bars up. */
  /** The Regal left lamp: 'park' (the parking brake set: red PARK BRAKE), 'hold' (Auto Hold holding the car: green AUTO
   *  HOLD) or null. The demo drive: parked in P, holding at a standstill otherwise.
   * @returns {?string}
   */
  _brakeLamp() {
    /** @type {(x: *) => boolean} */
    const known = (x) => x === true || x === false;
    const pb = known(this.parkBrake)
      ? this.parkBrake
      : known(this.parkBrakeVsm)
        ? this.parkBrakeVsm
        : known(this.parkBrakeCds)
          ? this.parkBrakeCds
          : null;
    if (pb === true) return "park";
    if (this.autoHold === "hold") return "hold";
    const d = this.car.data();
    if (
      pb === null &&
      this.autoHold === null &&
      d.demo &&
      isNum(d.speed) &&
      d.speed < 1
    )
      return d.stage === "P" ? "park" : "hold";
    return null;
  },

  /** Which way the indicator points, held while it is on (not blinking): -1 left, 1 right, 0 none or hazards. Always 0
   *  unless config.indicators (the Miku character points that way only then).
   * @returns {number}
   */
  _turnSide() {
    if (this.config.indicators !== true) return 0;
    const now = Date.now();
    let t =
      this.turn !== null && now - (this.turnAt || 0) < 5000 ? this.turn : null;
    if (t === null && this.car.data().demo)
      t =
        Math.floor(now / 6000) % 4 === 1
          ? "L"
          : Math.floor(now / 6000) % 4 === 3
            ? "R"
            : "";
    return t === "L" ? -1 : t === "R" ? 1 : 0;
  },

  /**
   * A Regal turn lamp lit now (blinking at 1.25 Hz).
   * @param {string} side 'L' or 'R'
   * @returns {boolean}
   */
  _turnLit(side) {
    const now = Date.now();
    let t =
      this.turn !== null && now - (this.turnAt || 0) < 5000 ? this.turn : null;
    if (t === null && this.car.data().demo)
      t = Math.floor(now / 6000) % 4 === 1 ? "L" : "";
    return !!t && t.indexOf(side) >= 0 && Math.floor(now / 400) % 2 === 0;
  },

  /**
   * The Regal CRUISE lamp lit: BMW's ACC car or bars up.
   * @returns {boolean}
   */
  _cruiseLit() {
    return (
      this.accOn ||
      (!!this.car.data().demo && Math.floor(Date.now() / 10000) % 3 === 2)
    );
  },

  /**
   * The Regal gear row's lit slot (REGAL_GEARS: P 0, R 1, N 2, D and S 3, M 5 the gear number), -1 for none.
   * @returns {number}
   */
  _regalGear() {
    const stage = this._token("stage");
    return Object.prototype.hasOwnProperty.call(REGAL_GEARS, stage)
      ? REGAL_GEARS[stage]
      : -1;
  },
};
