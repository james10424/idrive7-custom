"use strict";
/**
 * The Miku character's baked frames (tools/live2d_bake), loaded from the app's data folder and uploaded as one RGBA
 * asset with the shader's tables in pixel rows under the art.
 */
const fs = require("fs");
const path = require("path");
const { isNum, mib } = require("../../engine/util");

/** @typedef {import("../../hud").Widget} Widget */
/** @typedef {import("../../hud").HudApp} HudApp */
/** @typedef {import("../../cluster_render_client.js").ClusterRender} Client */
/** @typedef {{ lean: number, look: number, doze: number }} MikuCounts */
/**
 * The Miku bake's atlas.json (tools/live2d_bake); only what is read here.
 * @typedef {object} MikuInfo
 * @property {number[]} atlas [w, h]
 * @property {number[]} frame [w, h]
 * @property {number[]} anchor frame px between her feet
 * @property {Record<string, number[]>} frames idle, half, shut, talk
 * @property {Array<number[]>} [lean]
 * @property {Array<number[]>} [look]
 * @property {Array<number[]>} [doze]
 * @property {number[]} [leanShift]
 * @property {number[]} [leanShiftY]
 * @property {number[]} [lookShift]
 * @property {Array<number[]>} [dozeShift]
 * @property {Array<Record<string, *>>} [arms]
 * @property {Record<string, *>} [tails]
 * @property {number[]} [crop]
 * @property {number} [hipY]
 * @property {number} [headY]
 * @property {boolean} [breathe]
 * @property {string} [leanAxis] "fb" for a forward/back bake
 * @property {string} [pose]
 */
/**
 * The Miku frames as an RGBA asset on a connection (_sprite).
 * @typedef {object} SpriteAtlas
 * @property {number} ref
 * @property {Client} c
 * @property {number} ci
 * @property {MikuInfo} info
 * @property {number[]} size [w, h] with the table rows
 * @property {number} dataY where the table rows start
 * @property {MikuCounts} counts
 * @property {number} bytes pixel memory
 */

/**
 * The Miku shader's tables as pixel rows to go under the atlas art: 56 entries of two values each, each entry a 3x3 px
 * block (so a bilinear read at its middle gets it whole), opaque (alpha 255: a canvas or driver that premultiplies
 * leaves it alone), each value 12 bits: (v + 1024) * 2 in R (high 8) and B's high or low nibble, in G likewise:
 * -1024 .. 1023.5 px in half px. Entries: 0-15 the lean frames' atlas x, y; 16-31 each lean frame's head shift x, y
 * (y: the forward/back lean's head drop; 0 sideways); 32-39 the glance frames' x, y; 40-47 each glance's head shift; 48-51 the doze frames' x, y; 52-55 each doze
 * frame's head shift x, y. Returns { px, rows, counts: { lean, look, doze } }.
 * @param {MikuInfo} j atlas.json
 * @param {number} aw the atlas width, px
 * @returns {{ px: Buffer, rows: number, counts: MikuCounts }}
 */
function mikuData(j, aw) {
  /** @type {(v: *) => number[]} */
  const xy = (v) =>
      Array.isArray(v) ? [Number(v[0]) || 0, Number(v[1]) || 0] : [0, 0],
    /** @type {(a: *, i: number) => number} */
    num = (a, i) => (Array.isArray(a) && isNum(a[i]) ? a[i] : 0);
  const lean =
    Array.isArray(j.lean) && j.lean.length >= 3
      ? j.lean.slice(0, 15)
      : [j.frames.idle];
  const look =
    Array.isArray(j.look) && j.look.length >= 3 && j.look.length % 2
      ? j.look.slice(0, 7)
      : [];
  const doze = Array.isArray(j.doze) ? j.doze.slice(0, 4) : [];
  const e = [];
  for (let i = 0; i < 16; i++) e[i] = xy(lean[i]);
  for (let i = 0; i < 16; i++)
    e[16 + i] = [num(j.leanShift, i), num(j.leanShiftY, i)];
  for (let i = 0; i < 8; i++) {
    e[32 + i] = xy(look[i]);
    e[40 + i] = [num(j.lookShift, i), 0];
  }
  for (let i = 0; i < 4; i++) {
    e[48 + i] = xy(doze[i]);
    e[52 + i] = xy(Array.isArray(j.dozeShift) ? j.dozeShift[i] : null);
  }
  const per = Math.floor(aw / 3),
    rows = Math.ceil(e.length / per) * 3,
    px = Buffer.alloc(aw * rows * 4, 0);
  /** @type {(v: number) => number} */
  const q = (v) => Math.max(0, Math.min(4095, Math.round((v + 1024) * 2)));
  e.forEach((v, i) => {
    const a = q(v[0]),
      b = q(v[1]),
      x0 = (i % per) * 3,
      y0 = Math.floor(i / per) * 3;
    for (let dy = 0; dy < 3; dy++)
      for (let dx = 0; dx < 3; dx++) {
        const o = ((y0 + dy) * aw + x0 + dx) * 4;
        px[o] = a >> 4;
        px[o + 1] = b >> 4;
        px[o + 2] = ((a & 15) << 4) | (b & 15);
        px[o + 3] = 255;
      }
  });
  return {
    px,
    rows,
    counts: { lean: lean.length, look: look.length, doze: doze.length },
  };
}

/**
 * The Miku layout's baked frames: <data>/miku/atlas.json and
 * atlas.rgba (straight-alpha RGBA, atlas[0] x atlas[1] px), made by tools/live2d_bake and pushed by
 * scripts/deploy.sh --miku. They are not in the app: the character's art stays with its owner. Uploaded once as an
 * RGBA asset per connection and kept in hud.atlases (so the pixel memory counts it); new files (a later bake)
 * drop the old asset. Null, with hud.problem set, when the files are missing or bad.
 * @param {Widget} w
 * @param {number} ci connection index
 * @returns {?SpriteAtlas}
 */
function sprite(hud, w, ci) {
  // the HUD's Miku from miku/ (a forward/back lean bake, lean.axis "fb", works there too: its leanAxis turns
  // the arms' balance off)
  const sub = "miku",
    dir = path.join(hud.ctx.dataDir || ".", sub);
  let st;
  try {
    st = fs.statSync(path.join(dir, "atlas.rgba"));
  } catch (e) {
    st = null;
  }
  const pre = "sprite:" + ci + ":",
    key = pre + dir + ":" + (st ? st.mtimeMs : 0);
  if (hud.atlases.has(key)) return hud.atlases.get(key);
  // another bake (or a newer file) on this connection: drop the old asset before uploading, so one is in the
  // pixel memory at a time. Swapping this way while running works on the car (Nov 9 2026: Custom HUD 0.1.18's
  // Miku lean setting swapped her 1024x564 atlas between the sideways and fb bakes and the new frames showed)
  hud.atlases.forEach((a, k) => {
    if (k.indexOf(pre) === 0) {
      a.c.drop(a.ref);
      hud.atlases.delete(k);
    }
  });
  try {
    if (!st)
      throw new Error(
        "no baked frames in " +
          dir +
          " (tools/live2d_bake, then scripts/deploy.sh --" +
          sub +
          ")",
      );
    const info = JSON.parse(
      fs.readFileSync(path.join(dir, "atlas.json"), "utf8"),
    );
    const [aw, ah] = info.atlas || [];
    if (!(aw > 0 && ah > 0)) throw new Error('atlas.json: bad "atlas" size');
    // the instrument cluster (KOMBI) restarted on a 1024x1128 RGBA asset (Nov 2026): nothing over 1024 a side
    if (aw > 1024 || ah > 1024)
      throw new Error(
        "atlas " +
          aw +
          "x" +
          ah +
          " is over 1024 px a side, which restarts the instrument cluster; bake again with the current tools/live2d_bake",
      );
    if (
      !info.frames ||
      !info.frames.idle ||
      !Array.isArray(info.frame) ||
      !Array.isArray(info.anchor)
    )
      throw new Error('atlas.json: needs "frame", "anchor" and frames.idle');
    const art = fs.readFileSync(path.join(dir, "atlas.rgba"));
    if (art.length !== aw * ah * 4)
      throw new Error(
        "atlas.rgba is " +
          art.length +
          " bytes, " +
          aw +
          "x" +
          ah +
          " RGBA needs " +
          aw * ah * 4,
      );
    // the per-frame tables go in a few rows under the art, which the shader reads (mikuData), not in uniforms
    if (info.pose)
      throw new Error(
        "atlas.json is a " +
          info.pose +
          " bake (no layout draws one now): bake the standing one",
      );
    const data = mikuData(info, aw),
      h = ah + data.rows;
    if (h > 1024)
      throw new Error(
        "atlas " +
          aw +
          "x" +
          ah +
          " leaves no room under 1024 px for its " +
          data.rows +
          " rows of tables; bake again with the current tools/live2d_bake",
      );
    const px = Buffer.concat([art, data.px]);
    const c = hud._clientAt(ci);
    const ref = c.asset({
      target: hud.target,
      format: "rgba8",
      w: aw,
      h,
      sampling: "bilinear",
    });
    if (!ref) throw new Error("atlas asset refused (" + aw + "x" + h + ")");
    c.pixels(ref, null, px);
    const a = {
      ref,
      c,
      ci,
      info,
      size: [aw, h],
      dataY: ah,
      counts: data.counts,
      bytes: aw * h * 8,
    };
    hud.atlases.set(key, a);
    hud.log.info(
      "miku frames: " +
        Object.keys(info.frames).length +
        " of " +
        info.frame.join("x") +
        ", " +
        (info.tails ? "tails, " : "") +
        aw +
        "x" +
        h +
        " RGBA asset, " +
        mib(a.bytes) +
        " of pixel memory",
    );
    return a;
  } catch (e) {
    hud.problem = "Miku: " + e.message;
    hud.log.warn('widget "' + w.id + '": ' + e.message);
    return null;
  }
}

module.exports = { sprite, mikuData };
