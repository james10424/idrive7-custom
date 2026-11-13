"use strict";
/**
 * The app's data folder hud/ (fonts, built-in layouts). The kit's build packs it into
 * hud.pack next to this file; kit/pack.js reads the pack, or the plain folder when there
 * is none (running from apps/ on the Mac). json(rel) returns {} for a missing file.
 */
const path = require("path");

/**
 * The app's hud/ data, packed or as a folder (kit/runtime/pack.js).
 * @typedef {object} HudData
 * @property {(rel: string) => any} json the parsed JSON file, {} when missing
 * @property {(rel: string) => ?Buffer} buffer a file's bytes, null when missing
 */

/** @type {HudData} */
module.exports = require("./kit/pack").open(path.join(__dirname, "hud"));
