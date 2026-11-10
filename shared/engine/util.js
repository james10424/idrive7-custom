"use strict";
/**
 * Small helpers the engine, the car values and the widgets share.
 */

/**
 * A finite number.
 * @param {*} v
 * @returns {v is number}
 */
function isNum(v) {
  return typeof v === "number" && isFinite(v);
}

/**
 * A 0..255 colour as 0..1 RGB.
 * @param {number[]} c
 * @returns {number[]}
 */
function rgb(c) {
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

/**
 * A 0..255 colour (alpha optional) as 0..1 RGBA.
 * @param {number[]} c
 * @returns {number[]}
 */
function rgba(c) {
  return [
    c[0] / 255,
    c[1] / 255,
    c[2] / 255,
    (c[3] === undefined ? 255 : c[3]) / 255,
  ];
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function mib(bytes) {
  return (bytes / 1048576).toFixed(1) + " MiB";
}

module.exports = { isNum, rgb, rgba, pad2, mib };
