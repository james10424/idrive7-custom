"use strict";
/**
 * Small helpers the engine, the car values and the widgets share.
 */

const TEXT_MS = 200; // text re-draws at most 5 times a second (what BMW's own readouts do)
const MIB_BYTES = 1024 * 1024;

/**
 * A finite number.
 * @param {unknown} value
 * @returns {value is number}
 */
function isNum(value) {
  return typeof value === "number" && isFinite(value);
}

/**
 * A 0..255 colour as 0..1 RGB.
 * @param {number[]} color
 * @returns {number[]}
 */
function rgb(color) {
  return [color[0] / 255, color[1] / 255, color[2] / 255];
}

/**
 * A 0..255 colour (alpha optional) as 0..1 RGBA.
 * @param {number[]} color
 * @returns {number[]}
 */
function rgba(color) {
  return [
    color[0] / 255,
    color[1] / 255,
    color[2] / 255,
    (color[3] === undefined ? 255 : color[3]) / 255,
  ];
}

/**
 * @param {number} num
 * @returns {string}
 */
function pad2(num) {
  return num < 10 ? "0" + num : String(num);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function mib(bytes) {
  return (bytes / MIB_BYTES).toFixed(1) + " MiB";
}

module.exports = { isNum, rgb, rgba, pad2, mib, TEXT_MS };
