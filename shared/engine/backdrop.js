"use strict";
/**
 * A layout's baked backdrop ("backdrop": true, Grand National): what never changes while driving (the rdash shader's
 * frames, marks, zones and ticks, and the widgets marked "backdrop": true, the labels that depend on the Units setting
 * at most) drawn once on the bench into one opaque ETC2 image per Units setting, hud/backdrops/<layout>-<units>.etc2
 * with its .json ({ w, h, key }). On the car the rdash layer samples it (u_back, RDASH_LIVE) and draws only what moves
 * over it, and the backdrop widgets aren't drawn: a smaller shader, and the labels' sheets gone from the pixel memory.
 *
 * The key ties a backdrop to what it was baked from: those widgets, the rdash widget, the Units setting, the theme's
 * colours, the bake pass's shader and the fonts the widgets use. A missing backdrop, or one whose key no longer
 * matches (the layout, theme, fonts or shader changed), is refused with the reason on the status row: bake it again
 * (bench, "bench-backdrop", see bench/README.md).
 *
 * With CLUSTER_BACKDROP_BAKE=1 in the environment (the bench's bake mode, never on the car) the app draws only the
 * backdrop's parts instead (RDASH_BAKE and the backdrop widgets) and writes <data>/backdrop-bake.json ({ layout,
 * units, key, w, h }) for the bench to name and stamp what it captures.
 *
 * Plain Node 8.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const data = require("../hud_data");

const ETC2_BLOCK_PX = 4,
  ETC2_BLOCK_BYTES = 16;
const PIXEL_COPIES = 2; // cluster-render counts each image's bytes twice
const BAKE = process.env.CLUSTER_BACKDROP_BAKE === "1";

/** @typedef {import("./app").Widget} Widget */
/**
 * @typedef {object} Backdrop
 * @property {boolean} bake the bench's bake mode: draw the backdrop's parts, not the backdrop
 * @property {string} key
 * @property {number} [ref] the asset (not in bake mode)
 */

/**
 * The key of a backdrop: a hash of everything it is drawn from.
 * @param {Widget[]} widgets the layout's widgets (after its mode)
 * @param {string} units the Units setting
 * @param {*} theme the active theme's colours
 * @param {string} bakeShader the rdash bake pass's source
 * @returns {string}
 */
function backdropKey(widgets, units, theme, bakeShader) {
  const parts = widgets.filter((w) => w.backdrop || (w.type === "rdash" && !w.needleOnly));
  /** @type {Record<string, *>} */
  const fonts = {};
  parts.forEach((w) => {
    if (w.font && !fonts[w.font]) fonts[w.font] = data.json("fonts/" + w.font + ".json");
  });
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({ parts, units, theme, fonts }))
    .update(bakeShader)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Sets hud.backdrop for a layout with a backdrop and returns the widgets to draw: in bake mode only the backdrop's
 * parts, else all but the backdrop widgets, with the backdrop uploaded. Throws with the reason when the backdrop is
 * missing, wrong or out of date.
 * @param {import("./app").App} hud
 * @param {string} name the layout's file name
 * @param {Widget[]} shown the widgets the layout shows
 * @param {string} bakeShader
 * @returns {Widget[]}
 */
function useBackdrop(hud, name, shown, bakeShader) {
  const units = String(hud.setting("units") || "metric"),
    key = backdropKey(shown, units, hud.theme, bakeShader),
    rdash = shown.filter((w) => w.type === "rdash" && !w.needleOnly)[0];
  if (!rdash) throw new Error('"backdrop": true needs an rdash widget');
  if (BAKE) {
    hud.backdrop = { bake: true, key };
    try {
      fs.writeFileSync(
        path.join(hud.ctx.dataDir || ".", "backdrop-bake.json"),
        JSON.stringify({ layout: name, units, key, w: rdash.w, h: rdash.h }),
      );
    } catch (err) {
      hud.log.warn("backdrop bake: " + (err instanceof Error ? err.message : err));
    }
    hud.log.info("backdrop bake: drawing only the backdrop's parts (" + name + ", " + units + ", key " + key + ")");
    return shown.filter((w) => w.backdrop || (w.type === "rdash" && !w.needleOnly));
  }
  const base = "backdrops/" + name + "-" + units,
    bake = "bake it on the bench (bench-backdrop, bench/README.md)";
  const meta = data.json(base + ".json"),
    bytes = data.buffer(base + ".etc2");
  if (!bytes || !meta || !meta.key) throw new Error("no baked backdrop for " + units + " units (" + base + ".etc2): " + bake);
  if (meta.key !== key) throw new Error("the backdrop for " + units + " units is out of date with the layout: " + bake + " again");
  if (meta.w !== rdash.w || meta.h !== rdash.h || meta.w % ETC2_BLOCK_PX || meta.h % ETC2_BLOCK_PX ||
      bytes.length !== (meta.w / ETC2_BLOCK_PX) * (meta.h / ETC2_BLOCK_PX) * ETC2_BLOCK_BYTES)
    throw new Error("the backdrop for " + units + " units doesn't fit its layer (" + meta.w + "x" + meta.h + "): " + bake + " again");
  const conn = rdash.conn || 0,
    cacheKey = "backdrop:" + conn + ":" + name + ":" + units + ":" + key;
  let atlas = hud.atlases.get(cacheKey);
  if (!atlas) {
    // another backdrop on this connection (other units, a new bake): drop it first, so one is in the pixel memory
    hud.atlases.forEach((other, k) => {
      if (k.indexOf("backdrop:" + conn + ":") === 0) {
        other.c.drop(other.ref);
        hud.atlases.delete(k);
      }
    });
    const client = hud._clientAt(conn);
    const ref = client.asset({ target: hud.target, format: "etc2rgba", w: meta.w, h: meta.h, sampling: "nearest" });
    if (!ref) throw new Error("backdrop asset refused (" + meta.w + "x" + meta.h + " ETC2)");
    client.pixels(ref, null, bytes);
    atlas = { ref, c: client, ci: conn, bytes: bytes.length * PIXEL_COPIES };
    hud.atlases.set(cacheKey, atlas);
    hud.log.info(
      "backdrop " + base + ": " + meta.w + "x" + meta.h + " ETC2, " +
        ((bytes.length * PIXEL_COPIES) / 1048576).toFixed(1) + " MiB of pixel memory",
    );
  }
  hud.backdrop = { bake: false, key, ref: atlas.ref };
  return shown.filter((w) => !w.backdrop);
}

/**
 * A layout without a backdrop: no hud.backdrop, and any uploaded backdrop leaves the pixel memory.
 * @param {import("./app").App} hud
 */
function noBackdrop(hud) {
  hud.backdrop = null;
  hud.atlases.forEach((atlas, k) => {
    if (k.indexOf("backdrop:") === 0) {
      atlas.c.drop(atlas.ref);
      hud.atlases.delete(k);
    }
  });
}

module.exports = { useBackdrop, noBackdrop, backdropKey, BAKE };
