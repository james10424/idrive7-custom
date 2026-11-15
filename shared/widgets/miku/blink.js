"use strict";
/**
 * Miku's blink, shared by the baked close-up (index.js) and the live one (../miku_live): one recorded blink, the
 * bake's close.blink (a recording's eye closure), every MIKU_BLINK_MS at random and when her head sets off on a turn.
 */
const { isNum } = require("../../engine/util");

const MIKU_BLINK_OPEN = 0.05; // close-up only: a recorded blink is over once her eyes are less shut than this
const MIKU_BLINK_MS = [3000, 5000]; // close-up only: a blink this far apart (at random between), and as her head turns

/** @typedef {{ blinkAt?: number, blinkNext?: number, blink?: ?{ rate: number, closure: number[] } }} BlinkState */

/**
 * Close-up only: her eyes' closure now (0 open .. 1 shut, miku_only.glsl u_eh): one blink, the bake's (close.blink, a
 * recording's first blink) or else a made-up one, from state.blinkAt; a new one every MIKU_BLINK_MS at random, and
 * when her head sets off on a turn (the update starts that one).
 * @param {BlinkState} state
 * @param {number} now ms
 * @returns {number}
 */
function eyeClosure(state, now) {
  if (!isNum(state.blinkNext) || now >= state.blinkNext) {
    if (isNum(state.blinkNext)) state.blinkAt = now;
    state.blinkNext = now + MIKU_BLINK_MS[0] + Math.random() * (MIKU_BLINK_MS[1] - MIKU_BLINK_MS[0]);
  }
  const s = (now - (isNum(state.blinkAt) ? state.blinkAt : -1e9)) / 1000,
    blink = state.blink;
  if (blink) {
    const at = s * blink.rate,
      i = Math.floor(at);
    if (i < 0 || i >= blink.closure.length) return 0;
    const a = blink.closure[i],
      b = i + 1 < blink.closure.length ? blink.closure[i + 1] : 0;
    return Math.round((a + (b - a) * (at - i)) * 100) / 100;
  }
  /** @type {(a: number, b: number, x: number) => number} */
  const smooth = (a, b, x) => {
    const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  return s < 0 || s > 0.3 ? 0 : Math.round(smooth(0, 0.06, s) * (1 - smooth(0.1, 0.22, s)) * 100) / 100;
}

/**
 * One blink out of the bake's blink curve (atlas.json close.blink: a recording's eye closure, `rate` samples a
 * second): from where her eyes first start to shut until they're open again; null if the curve has none.
 * @param {*} close
 * @returns {?{ rate: number, closure: number[] }}
 */
function blinkOf(close) {
  const blink = close && close.blink;
  if (!blink || !(blink.rate > 0) || !Array.isArray(blink.closure) || blink.closure.length < 2) return null;
  const c = blink.closure;
  if (!c.every((v) => typeof v === "number" && v >= 0 && v <= 1)) return null;
  let i0 = -1;
  for (let i = 1; i < c.length && i0 < 0; i++) if (c[i] > 0 && c[i - 1] === 0) i0 = i - 1;
  if (i0 < 0) return null;
  // its end: open again (under MIKU_BLINK_OPEN past its peak; the curve stays a few % shut until the next blink)
  let peak = i0 + 1;
  while (peak + 1 < c.length && c[peak + 1] >= c[peak]) peak++;
  let i1 = peak;
  while (i1 < c.length && c[i1] >= MIKU_BLINK_OPEN) i1++;
  return { rate: blink.rate, closure: c.slice(i0, i1).concat([0]) };
}

module.exports = { eyeClosure, blinkOf, MIKU_BLINK_MS, MIKU_BLINK_OPEN };
