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

const W = Number(process.env.SIDE_W) || 800,
  H = Number(process.env.SIDE_H) || 480;
const secs = Number(process.argv[2]) || 60;

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
  fill(0, 0, W, 4, white);
  fill(0, H - 4, W, 4, white);
  fill(0, 0, 4, H, white);
  fill(W - 4, 0, 4, H, white);
  const size = Math.round(Math.min(W, H) / 6);
  fill(8, 8, size, size, [255, 40, 40]);
  fill(W - 8 - size, 8, size, size, [40, 220, 80]);
  fill(8, H - 8 - size, size, size, [60, 110, 255]);
  fill(W - 8 - size, H - 8 - size, size, size, [255, 210, 30]);
  fill(
    Math.round(W * 0.2),
    Math.round(H / 2) - 6,
    Math.round(W * 0.6),
    12,
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
