"use strict";
/**
 * The Miku character's glances and dozing while the car idles (see idle() below).
 */
const { isNum } = require("../../engine/util");

/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("./index").MikuState} MikuState */

const MIKU_IDLE_G = 0.03; // below this |longitudinal g| the car idles: she glances around (the lean is not gated)
const MIKU_GLANCE_AFTER_MS = 1000; // the first glance this long after the car goes idle
const MIKU_LOOK_K = 30; // the glance's spring (1/s^2): a turn of about half a second
const MIKU_LOOK_C = 11; // critically damped: no overshoot
const MIKU_DOZE_AFTER_MS = 15000; // stopped and idle this long: she starts dozing
const MIKU_DOZE_PHASE_MS = 5000; // then dozes this long, wakes this long (glancing), dozes again, and so on
const MIKU_DROOP_W = 1.6; // her droop's spring (rad/s, critically damped): about 3 s to the bottom
const MIKU_RISE_W = 3; // waking in the loop: about 1.5 s
const MIKU_WAKE_W = 5; // waking for good when the car moves: about 1 s

/**
 * The Miku character while the car idles (|longitudinal g| under MIKU_IDLE_G): from MIKU_GLANCE_AFTER_MS on she
 * glances left or right now and then (x.look -1 .. 1 on a critically damped spring: turn, hold 1 to 3 s, back,
 * a pause of 2 to 6 s), and once the car has also stood still for MIKU_DOZE_AFTER_MS she loops: dozes for
 * MIKU_DOZE_PHASE_MS (x.doze 0 .. 1: eyes shut, then the head drooping), wakes for as long (head up, eyes open,
 * glancing), dozes again, and so on; x.doze rides a critically damped spring so neither the droop nor the waking
 * snaps. Any g past the deadzone or
 * pulling away ends both smoothly; the lean itself is never gated.
 * @param {WidgetState & MikuState} state
 * @param {number} now
 * @param {number} dt ms
 * @param {?number} gLong
 * @param {?number} speed
 * @returns {void}
 */
function idle(state, now, dt, gLong, speed) {
  const idle = !isNum(gLong) || Math.abs(gLong) < MIKU_IDLE_G,
    still = isNum(speed) && speed < 1;
  state.idleMs = idle ? (state.idleMs || 0) + dt : 0;
  state.stillMs = idle && still ? (state.stillMs || 0) + dt : 0;
  if (!isNum(state.look)) {
    state.look = 0;
    state.lookV = 0;
    state.doze = 0;
    state.dozeV = 0;
    state.lookT = 0;
    state.lookUntil = 0;
  }
  // the doze loop: doze, wake, doze, ... from MIKU_DOZE_AFTER_MS on, MIKU_DOZE_PHASE_MS each
  const looping =
    state.dozeN !== undefined && state.stillMs >= MIKU_DOZE_AFTER_MS;
  const dozing =
    looping &&
    Math.floor((state.stillMs - MIKU_DOZE_AFTER_MS) / MIKU_DOZE_PHASE_MS) %
      2 ===
      0;
  if (dozing) state.wokeUp = true;
  /** @type {(min: number, max: number) => number} */
  const rnd = (min, max) => min + Math.random() * (max - min);
  // the glance's target: none unless idle (and not dozing); otherwise turn, hold, return, pause, at random
  if (!idle || dozing || state.lookN < 3) {
    state.lookT = 0;
    state.lookUntil = 0;
  } else if (state.idleMs >= MIKU_GLANCE_AFTER_MS) {
    // the first glance: straight away when the car goes idle, soon after she wakes in the doze loop
    if (!state.lookUntil) {
      state.lookT = 0;
      state.lookUntil =
        now +
        (state.idleMs - dt < MIKU_GLANCE_AFTER_MS
          ? 0
          : state.wokeUp
            ? rnd(800, 1800)
            : rnd(2000, 6000));
      state.wokeUp = false;
    }
    if (now >= state.lookUntil) {
      if (state.lookT) {
        state.lookT = 0;
        state.lookUntil = now + rnd(2000, 6000);
      } else {
        state.lookT = (Math.random() < 0.5 ? -1 : 1) * rnd(0.45, 1);
        state.lookUntil = now + rnd(1000, 3000) + 500;
      }
    }
  }
  for (let left = dt / 1000; left > 0; left -= 0.01) {
    const stepSec = Math.min(0.01, left);
    state.lookV +=
      (MIKU_LOOK_K * (state.lookT - state.look) - MIKU_LOOK_C * state.lookV) *
      stepSec;
    state.look = Math.max(-1, Math.min(1, state.look + state.lookV * stepSec));
  }
  if (
    !state.lookT &&
    Math.abs(state.look) < 0.002 &&
    Math.abs(state.lookV) < 0.01
  ) {
    state.look = 0;
    state.lookV = 0;
  }
  // the droop and the waking on a critically damped spring: each starts gently and settles without a bounce
  const target = dozing ? 1 : 0,
    omega = dozing ? MIKU_DROOP_W : looping ? MIKU_RISE_W : MIKU_WAKE_W;
  for (let left = dt / 1000; left > 0; left -= 0.01) {
    const stepSec = Math.min(0.01, left);
    state.dozeV +=
      (omega * omega * (target - state.doze) - 2 * omega * state.dozeV) *
      stepSec;
    state.doze = Math.max(0, Math.min(1, state.doze + state.dozeV * stepSec));
  }
  if (!target && state.doze < 0.002 && Math.abs(state.dozeV) < 0.01) {
    state.doze = 0;
    state.dozeV = 0;
  }
}

module.exports = { idle };
