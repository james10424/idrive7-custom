"use strict";
/**
 * What the driver can actually see of each target, measured from car photos of the calibration grid from the
 * driver's seat (Nov 5 2026, design/photos/calibration-2026-11-05.json next to the pictures; the hood line, the belt
 * light and the HUD window again on Nov 12 2026). The renderer draws 1:1,
 * but parts of the panel are hidden by the car and parts of the HUD fall outside the
 * windshield window. Used by layouts.js (a warning per widget) and the bench (the car view).
 *
 * Plain Node 8 (the car's 8.16.2): no optional chaining, no ??, no dependencies.
 */

/** Cluster (1920x720): the first visible y along each vertical line [x, y]; the hood hides
 *  everything above it. Linear between points. Bottom and sides are fully visible. The line moves with the eye: the
 *  grid photos of Nov 5 and Nov 12 2026 (the top of each 100 px line) were taken from different points, so at each x
 *  this is the more visible of the two (a Nov 12 driving photo shows Grand National's right pod corner, x 1830 y 155,
 *  clear, which the Nov 12 grid photo alone would have hidden). x 800-1100 are behind the dash camera on Nov 12. */
/** @type {Array<[number, number]>} */
const HOOD = [
  [0, 210],
  [100, 138],
  [200, 85],
  [300, 48],
  [400, 30],
  [500, 17],
  [600, 12],
  [700, 4],
  [800, 3],
  [900, 2],
  [1000, 1],
  [1100, 2],
  [1200, 5],
  [1300, 10],
  [1400, 15],
  [1500, 27],
  [1600, 41],
  [1700, 81],
  [1800, 128],
  [1900, 196],
  [1920, 232],
];
/** The dash camera hangs in front of the panel's top middle, from the top down to y ~132 (car photo of the Grand National
 *  theme, Nov 8 2026): [x0, y0, x1, y1]. */
/** @type {[number, number, number, number]} */
const CAMERA = [760, 0, 1200, 135];
/** BMW draws a solid black box over our panel here (its gear slot): [x0, y0, x1, y1]. */
/** @type {[number, number, number, number]} */
const BLACK_BOX = [1406, 342, 1597, 419];
/** BMW's seat-belt warning light is drawn over us here: [x0, y0, x1, y1] (its bottom to y 712 on Nov 12 2026). */
/** @type {[number, number, number, number]} */
const BELT = [587, 663, 626, 712];
/** BMW's gear letter in the bottom row and the black box behind it, drawn over us (P / R / N / D; car photos with the
 *  Sport theme, Nov 7 2026, and Nov 9 2026: the box cut 6 px off the bottom of Sport's route strip). */
/** @type {[number, number, number, number]} */
const GEAR = [1380, 668, 1455, 713];
/** The part of the 800x480 HUD target seen through the windshield (eye-position dependent): x 120..680, y 100..380 on
 *  Nov 12 2026 (485x278 on Nov 5, from another head position or HUD height). */
const HUD_WINDOW = { x: 120, y: 100, w: 560, h: 280 };

/**
 * The first visible y at x on the panel (interpolated along HOOD).
 * @param {number} x
 * @returns {number}
 */
function hoodY(x) {
  if (x <= HOOD[0][0]) return HOOD[0][1];
  const last = HOOD[HOOD.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < HOOD.length; i++) {
    const prev = HOOD[i - 1],
      next = HOOD[i];
    if (x <= next[0])
      return (
        prev[1] + ((next[1] - prev[1]) * (x - prev[0])) / (next[0] - prev[0])
      );
  }
  return last[1];
}

/** @typedef {{ id?: string, x: number, y: number, w: number, h: number }} Rect a widget's box */
/**
 * @param {Rect} rect
 * @param {number[]} box [x0, y0, x1, y1]
 * @returns {boolean}
 */
function overlaps(rect, box) {
  return (
    rect.x < box[2] &&
    rect.x + rect.w > box[0] &&
    rect.y < box[3] &&
    rect.y + rect.h > box[1]
  );
}

/**
 * Warnings (strings, one per problem) for the widgets ({ id, x, y, w, h }) of a layout on
 * `target` ('panel' or 'hud'). Never throws; a widget without numeric x/y/w/h is skipped.
 * @param {Rect[]} widgets
 * @param {"panel"|"hud"} target
 * @returns {string[]}
 */
function check(widgets, target) {
  /** @type {string[]} */
  const out = [];
  if (!Array.isArray(widgets)) return out;
  widgets.forEach((widget) => {
    if (
      !widget ||
      typeof widget.x !== "number" ||
      typeof widget.y !== "number" ||
      typeof widget.w !== "number" ||
      typeof widget.h !== "number"
    )
      return;
    const id = String(widget.id);
    if (target === "panel") {
      // the top edge: both corners, then a few samples along it (the hood curve is not straight)
      /** @type {Array<{ d: number, what: string }>} */
      const under = [];
      /** @type {(x: number, what: string) => void} */
      const tryX = (x, what) => {
        const depth = Math.ceil(hoodY(x) - widget.y);
        if (depth > 0) under.push({ d: depth, what });
      };
      tryX(widget.x, "top-left corner");
      tryX(widget.x + widget.w, "top-right corner");
      const steps = 4;
      for (let i = 1; i < steps; i++)
        tryX(
          widget.x + (widget.w * i) / steps,
          "top edge at x " + Math.round(widget.x + (widget.w * i) / steps),
        );
      if (under.length) {
        const worst = under.reduce((deepest, entry) =>
          entry.d > deepest.d ? entry : deepest,
        );
        out.push(id + ": " + worst.what + " " + worst.d + " px under the hood");
      }
      if (overlaps(widget, CAMERA)) {
        out.push(
          id +
            ": behind the dash camera x" +
            CAMERA[0] +
            "-" +
            CAMERA[2] +
            " y" +
            CAMERA[1] +
            "-" +
            CAMERA[3],
        );
      }
      if (overlaps(widget, BLACK_BOX)) {
        out.push(
          id +
            ": overlaps BMW's gear box x" +
            BLACK_BOX[0] +
            "-" +
            BLACK_BOX[2] +
            " y" +
            BLACK_BOX[1] +
            "-" +
            BLACK_BOX[3],
        );
      }
      if (overlaps(widget, GEAR)) {
        out.push(
          id +
            ": overlaps BMW's gear letter x" +
            GEAR[0] +
            "-" +
            GEAR[2] +
            " y" +
            GEAR[1] +
            "-" +
            GEAR[3],
        );
      }
      if (overlaps(widget, BELT)) {
        out.push(
          id +
            ": overlaps BMW's seat-belt light x" +
            BELT[0] +
            "-" +
            BELT[2] +
            " y" +
            BELT[1] +
            "-" +
            BELT[3],
        );
      }
    } else if (target === "hud") {
      const win = HUD_WINDOW;
      const overflow = Math.max(
        win.x - widget.x,
        win.y - widget.y,
        widget.x + widget.w - (win.x + win.w),
        widget.y + widget.h - (win.y + win.h),
      );
      if (overflow > 0) {
        out.push(
          id +
            ": " +
            Math.ceil(overflow) +
            " px outside the visible HUD window " +
            win.x +
            "," +
            win.y +
            " " +
            win.w +
            "x" +
            win.h,
        );
      }
    }
  });
  return out;
}

module.exports = {
  HOOD,
  CAMERA,
  BLACK_BOX,
  BELT,
  GEAR,
  HUD_WINDOW,
  hoodY,
  check,
};
