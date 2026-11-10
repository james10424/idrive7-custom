"use strict";
/**
 * BMW's speed scale and where a speed sits on it (the Sport theme's bracket, the scale labels' "near").
 */

// BMW's speed scale: even steps to 120 mph (180 km/h), then wider ones to 200 mph (320 km/h)
/** @type {Record<string, number[]>} */
const SPEED_SCALE = {
  us: [0, 20, 40, 60, 80, 100, 120, 160, 200],
  metric: [0, 30, 60, 90, 120, 150, 180, 250, 320],
};
/**
 * speed (display unit) -> 0..1 along a scale of evenly spaced labels
 * @param {number} speed
 * @param {number[]} marks
 * @returns {number}
 */
function scaleFrac(speed, marks) {
  if (!(speed > 0)) return 0;
  for (let i = 1; i < marks.length; i++)
    if (speed <= marks[i])
      return (
        (i - 1 + (speed - marks[i - 1]) / (marks[i] - marks[i - 1])) /
        (marks.length - 1)
      );
  return 1;
}

module.exports = { SPEED_SCALE, scaleFrac };
