"use strict";
/**
 * HUD side-slot probe (run on the car, by hand): can our layer show in BMW's HUD pop-up slot 0x322 while BMW's route
 * guidance shows in 0x300? Our main HUD slot 0x323 switches 0x300 off (the slot table, X3, Nov 7 2026); 0x322 stayed
 * enabled. Needs cluster-render's map target pointed at 0x322 by tools/hud_side_probe.conf in its local conf.
 *
 *   node hud_side_probe.js [seconds=60]
 *
 * Draws on target "map" (its size from the conf): a white frame round the whole scene, a coloured square in each
 * corner (top-left red, top-right green, bottom-left blue, bottom-right yellow) and a white bar across the middle,
 * so a photo shows where the slot sits on the windshield, whether it is cropped or scaled, and which way is up. It logs
 * the target's state as cluster-render reports it.
 */
const {
  ClusterRender,
} = require("/var/opt/cluster-render/current/cluster_render_client.js");

const DEFAULT_W = 800, // the HUD scene's size, unless SIDE_W / SIDE_H say otherwise
  DEFAULT_H = 480,
  DEFAULT_SECS = 60;
const FRAME = 4, // px: the white frame's width
  INSET = 8, // px: the corner squares from the edges
  SQUARE_DIV = 6, // a corner square's side is the shorter side over this
  BAR_X = 0.2, // the middle bar starts this fraction across
  BAR_W = 0.6, // and spans this fraction of the width
  BAR_H = 12; // px

const W = Number(process.env.SIDE_W) || DEFAULT_W,
  H = Number(process.env.SIDE_H) || DEFAULT_H;
const secs = Number(process.argv[2]) || DEFAULT_SECS;

/**
 * The test picture, W x H RGBA.
 * @returns {Buffer}
 */
function picture() {
  const pixels = Buffer.alloc(W * H * 4, 0);
  /**
   * @param {number} x0
   * @param {number} y0
   * @param {number} w
   * @param {number} h
   * @param {number[]} color RGB
   */
  const fill = (x0, y0, w, h, color) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
        const offset = (y * W + x) * 4;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
  };
  const white = [240, 240, 240];
  fill(0, 0, W, FRAME, white);
  fill(0, H - FRAME, W, FRAME, white);
  fill(0, 0, FRAME, H, white);
  fill(W - FRAME, 0, FRAME, H, white);
  const size = Math.round(Math.min(W, H) / SQUARE_DIV);
  fill(INSET, INSET, size, size, [255, 40, 40]);
  fill(W - INSET - size, INSET, size, size, [40, 220, 80]);
  fill(INSET, H - INSET - size, size, size, [60, 110, 255]);
  fill(W - INSET - size, H - INSET - size, size, size, [255, 210, 30]);
  fill(
    Math.round(W * BAR_X),
    Math.round(H / 2) - BAR_H / 2,
    Math.round(W * BAR_W),
    BAR_H,
    white,
  );
  return pixels;
}

const TARGET = process.env.SIDE_TARGET || "map";
const client = new ClusterRender("hud_side_probe");
const ref = client.image({
  target: TARGET,
  klass: "overlay",
  z: 0,
  x: 0,
  y: 0,
  w: W,
  h: H,
  iw: W,
  ih: H,
});
client.on("ready", () => {
  console.log("connected; drawing " + W + "x" + H + " on target " + TARGET);
  client.pixels(ref, null, picture());
});
client.on("target", (name, state, holder, reason) =>
  console.log(
    "target " +
      name +
      ": " +
      state +
      (holder ? " (holder " + holder + ")" : "") +
      (reason ? ": " + reason : ""),
  ),
);
client.on("layer", (layerRef, state, reason) =>
  console.log(
    "layer " + layerRef + ": " + state + (reason ? ": " + reason : ""),
  ),
);
client.on("refused", (op, layerRef, reason) =>
  console.log("refused " + op + " " + layerRef + ": " + reason),
);
client.connect();
setTimeout(() => {
  console.log("done");
  client.close();
  process.exit(0);
}, secs * 1000);
