"use strict";
/**
 * Lamps: the parking brake / Auto Hold, the indicators, cruise, and the gear row's lit slot.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const { REGAL_GEARS } = require("./consts");
const { isNum } = require("../engine/util");

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /** The Regal lamps. Brake: the brake lights (the demo drive: while slowing). Turn: blinking at 1.25 Hz while the car says
   *  that side (hazards: both); the demo drive blinks left now and then. Cruise: BMW's ACC car or bars up. */
  /** The Regal left lamp: 'park' (the parking brake set: red PARK BRAKE), 'hold' (Auto Hold holding the car: green AUTO
   *  HOLD) or null. The demo drive: parked in P, holding at a standstill otherwise.
   * @returns {?string}
   */
  _brakeLamp() {
    /** @type {(value: *) => boolean} */
    const known = (value) => value === true || value === false;
    const parkBrake = known(this.parkBrake)
      ? this.parkBrake
      : known(this.parkBrakeVsm)
        ? this.parkBrakeVsm
        : known(this.parkBrakeCds)
          ? this.parkBrakeCds
          : null;
    if (parkBrake === true) return "park";
    if (this.autoHold === "hold") return "hold";
    const data = this.car.data();
    if (
      parkBrake === null &&
      this.autoHold === null &&
      data.demo &&
      isNum(data.speed) &&
      data.speed < 1
    )
      return data.stage === "P" ? "park" : "hold";
    return null;
  },

  /** Which way the indicator points, held while it is on (not blinking): -1 left, 1 right, 0 none or hazards. Always 0
   *  unless config.indicators (the Miku character points that way only then).
   * @returns {number}
   */
  _turnSide() {
    if (this.config.indicators !== true) return 0;
    const now = Date.now();
    // the car's last report, kept until the next: the car sends the indicators when they change, so a signal on for more
    // than a few seconds is still on (a 5 s timeout dropped it, and Miku's close-up turned back to straight ahead)
    let turn = this.turn;
    if (turn === null && this.car.data().demo)
      turn =
        Math.floor(now / 6000) % 4 === 1
          ? "L"
          : Math.floor(now / 6000) % 4 === 3
            ? "R"
            : "";
    return turn === "L" ? -1 : turn === "R" ? 1 : 0;
  },

  /**
   * A Regal turn lamp lit now (blinking at 1.25 Hz).
   * @param {string} side 'L' or 'R'
   * @returns {boolean}
   */
  _turnLit(side) {
    const now = Date.now();
    // the car's last report, kept until the next: the car sends the indicators when they change, so a signal on for more
    // than a few seconds is still on (a 5 s timeout dropped it, and Miku's close-up turned back to straight ahead)
    let turn = this.turn;
    if (turn === null && this.car.data().demo)
      turn = Math.floor(now / 6000) % 4 === 1 ? "L" : "";
    return !!turn && turn.indexOf(side) >= 0 && Math.floor(now / 400) % 2 === 0;
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
   * The Regal gear row's lit slot (REGAL_GEARS: P 0, R 1, N 2, D, S and M 3), -1 for none.
   * @returns {number}
   */
  _regalGear() {
    const stage = this._token("stage");
    return Object.prototype.hasOwnProperty.call(REGAL_GEARS, stage)
      ? REGAL_GEARS[stage]
      : -1;
  },
});
