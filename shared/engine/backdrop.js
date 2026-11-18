"use strict";
/**
 * A layout's baked backdrop ("backdrop": true; Grand National and Sport): what never changes while driving (the base
 * layer's static parts, and the widgets marked "backdrop": true, labels that depend on no setting: the unit and tank
 * labels are live text since Custom Cluster 0.1.66, so any mix of unit settings shares it) drawn once on the bench
 * into one ETC2 image, hud/backdrops/<layout>.etc2 with its .json ({ w, h, key }). The base layer is the layout's rdash (Grand National: frames, marks, zones and ticks; opaque) or
 * sdash (Sport: the black, the brackets' lines and label marks, the bars' rails; see-through in the map window). A
 * base with a map window ("hole", Sport) whose window is open ("mapWindow", always on in Custom Cluster since 0.1.66)
 * uses <layout>-map.etc2, the window cut in its alpha; only one backdrop is ever in the pixel memory, another dropped
 * before it goes up. On the car the base layer samples it (u_back,
 * RDASH_LIVE / SDASH_LIVE) and draws only what moves over it (or under it: Sport's bands), and the backdrop widgets
 * aren't drawn: a smaller shader, and the labels' sheets gone from the pixel memory.
 *
 * The key ties a backdrop to what it was baked from: those widgets, the base widget, the theme's colours, the bake
 * pass's shader and the fonts the widgets use, and where it matters whether the map window is open. A backdrop widget
 * may hold no token that depends on a setting or the car (useBackdrop refuses it). A missing backdrop, or one whose
 * key no longer matches (the layout, theme, fonts or shader changed), is refused with the reason on the status row:
 * bake it again (bench, "bench-backdrop", see bench/README.md).
 *
 * With CLUSTER_BACKDROP_BAKE=1 in the environment (the bench's bake mode, never on the car) the app draws only the
 * backdrop's parts instead (the BAKE pass and the backdrop widgets) and writes <data>/backdrop-bake.json ({ layout,
 * file, key, w, h }) for the bench to name and stamp what it captures.
 *
 * Plain Node 8.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const data = require("../hud_data");

const ETC2_BLOCK_PX = 4,
  ETC2_BLOCK_BYTES = 16;
const PIXEL_COPIES = 1; // cluster-render charges an etc2rgba asset's bytes once (an RGBA one twice)
const BAKE = process.env.CLUSTER_BACKDROP_BAKE === "1";

/** @typedef {import("./app").Widget} Widget */
/**
 * @typedef {object} Backdrop
 * @property {boolean} bake the bench's bake mode: draw the backdrop's parts, not the backdrop
 * @property {string} key
 * @property {number} [ref] the asset (not in bake mode)
 */

/**
 * The layer a backdrop belongs to: the layout's rdash (not its needles) or sdash widget.
 * @param {Widget} w
 * @returns {boolean}
 */
const isBase = (w) => (w.type === "rdash" && !w.needleOnly) || w.type === "sdash";

/**
 * The key of a backdrop: a hash of everything it is drawn from.
 * @param {Widget[]} widgets the layout's widgets (after its mode)
 * @param {*} theme the active theme's colours
 * @param {string} bakeShader the base widget's bake pass's source
 * @param {Record<string, *>} [more] whatever else it depends on (the map window, the tank); left out when empty, so
 *   Grand National's keys stay what they were
 * @returns {string}
 */
function backdropKey(widgets, theme, bakeShader, more) {
  const parts = widgets.filter((w) => w.backdrop || isBase(w));
  /** @type {Record<string, *>} */
  const fonts = {};
  parts.forEach((w) => {
    if (w.font && !fonts[w.font]) fonts[w.font] = data.json("fonts/" + w.font + ".json");
  });
  /** @type {Record<string, *>} */
  const what = { parts, theme, fonts };
  if (more && Object.keys(more).length) what.more = more;
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(what))
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
 * @returns {Widget[]}
 */
function useBackdrop(hud, name, shown) {
  const layer = shown.filter(isBase)[0];
  if (!layer) throw new Error('"backdrop": true needs an rdash or sdash widget');
  /** @type {Record<string, *>} */
  const more = {};
  // a map window ("hole"): one backdrop with it open, one closed
  const map = !!layer.hole && hud._hole(layer)[2] > 0;
  if (layer.hole) more.map = map;
  // a backdrop label with a token (the units, the tank) would be wrong for some settings: those are live text
  const tokened = shown.filter((w) => w.backdrop && /\{\{/.test(String(w.text || "")))[0];
  if (tokened) throw new Error('backdrop widget "' + (tokened.id || tokened.text) + '" has a {{token}}: take "backdrop" off it');
  const key = backdropKey(shown, hud.theme, require("../widgets/" + layer.type).BAKE, more),
    file = name + (map ? "-map" : ""),
    what = name + (layer.hole ? ", map window " + (map ? "open" : "closed") : "");
  if (BAKE) {
    hud.backdrop = { bake: true, key };
    try {
      fs.writeFileSync(
        path.join(hud.ctx.dataDir || ".", "backdrop-bake.json"),
        JSON.stringify({ layout: name, file, key, w: layer.w, h: layer.h }),
      );
    } catch (err) {
      hud.log.warn("backdrop bake: " + (err instanceof Error ? err.message : err));
    }
    hud.log.info("backdrop bake: drawing only the backdrop's parts (" + file + ", key " + key + ")");
    return shown.filter((w) => w.backdrop || isBase(w));
  }
  const base = "backdrops/" + file,
    bake = "bake it on the bench (bench-backdrop, bench/README.md)";
  const meta = data.json(base + ".json"),
    bytes = data.buffer(base + ".etc2");
  if (!bytes || !meta || !meta.key) throw new Error("no baked backdrop for " + what + " (" + base + ".etc2): " + bake);
  if (meta.key !== key) throw new Error("the backdrop for " + what + " is out of date with the layout: " + bake + " again");
  if (meta.w !== layer.w || meta.h !== layer.h || meta.w % ETC2_BLOCK_PX || meta.h % ETC2_BLOCK_PX ||
      bytes.length !== (meta.w / ETC2_BLOCK_PX) * (meta.h / ETC2_BLOCK_PX) * ETC2_BLOCK_BYTES)
    throw new Error("the backdrop for " + what + " doesn't fit its layer (" + meta.w + "x" + meta.h + "): " + bake + " again");
  const conn = layer.conn || 0,
    cacheKey = "backdrop:" + conn + ":" + file + ":" + key;
  let atlas = hud.atlases.get(cacheKey);
  if (!atlas) {
    // another backdrop on this connection (the map window, a new bake): drop it first, so one is in the
    // pixel memory
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
