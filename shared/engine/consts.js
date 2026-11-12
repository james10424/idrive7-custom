"use strict";
/**
 * The engine's limits and tables.
 */
const widgetTypes = require("../widgets");

/**
 * Drawn as pixels (an image layer), not a shader.
 * @param {string} type
 * @returns {boolean}
 */
const isImage = (type) => !!(widgetTypes[type] && widgetTypes[type].image);
const STATUS_ASK_MS = 2000; // after a rebuild: ask cluster-render for its own status text
const LAYER_BUDGET = 64; // cluster-render's limit per client connection (CompositorLimits.per_client: 8 until 0.4.2, 64 since)
const MAX_CONN = 4; // connections a layout may ask for ("conn"); 96 layers service-wide, 64 per connection
const PIXEL_BYTES = 32 * 1024 * 1024; // cluster-render's pixel memory for every app's images together: pixel_mib, 32 MiB in our fork from 0.5.4 (upstream a fixed 16)
const SHEET_AREA_FRAC = 4; // the first sheet size limit: 1/4 of the target area (see the header)
const IMAGE_PX_BYTES = 8; // pixel memory per image layer pixel: RGBA, counted twice by cluster-render
const TICK_MS = 50; // 20 Hz: shift bar and gauges
const DEFAULT_LOCATION = { lat: 35.2271, lon: -80.8431 }; // Charlotte, NC: for the Auto theme's sunset
/** @type {Record<string, number[]>} */
const TARGET_SIZES = { hud: [800, 480], panel: [1920, 720] };
/** @type {Record<string, string>} */
const MODE_KEY = { comfort: "inComfort", sport: "inSport", eco: "inEco" };
/** @type {Record<string, string>} */
const MODE_TEXT = {
  cruise: "BMW's driver assistance",
  nav: "BMW's guidance",
  cruiseNav: "BMW's guidance and driver assistance",
};

module.exports = {
  isImage,
  STATUS_ASK_MS,
  LAYER_BUDGET,
  MAX_CONN,
  PIXEL_BYTES,
  SHEET_AREA_FRAC,
  IMAGE_PX_BYTES,
  TICK_MS,
  DEFAULT_LOCATION,
  TARGET_SIZES,
  MODE_KEY,
  MODE_TEXT,
};
