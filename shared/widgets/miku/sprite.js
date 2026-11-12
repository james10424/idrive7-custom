"use strict";
/**
 * The Miku character's baked frames (tools/live2d_bake), loaded from the app's data folder and uploaded as one RGBA
 * asset with the shader's tables in pixel rows under the art.
 */
const fs = require("fs");
const path = require("path");
const { isNum, mib } = require("../../engine/util");

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").App} HudApp */
/** @typedef {import("../../cluster_render_client.js").ClusterRender} Client */
/** @typedef {{ lean: number }} MikuCounts */
/**
 * The Miku bake's atlas.json (tools/live2d_bake); only what is read here.
 * @typedef {object} MikuInfo
 * @property {number[]} atlas [w, h]
 * @property {number[]} frame [w, h]
 * @property {number[]} anchor frame px between her feet
 * @property {Record<string, number[]>} frames idle, half, shut, talk
 * @property {Array<number[]>} [lean]
 * @property {number[]} [leanShift]
 * @property {number[]} [leanShiftY]
 * @property {Array<Record<string, *>>} [arms]
 * @property {Record<string, *>} [tails]
 * @property {number[]} [crop]
 * @property {number} [hipY]
 * @property {number} [headY]
 * @property {boolean} [breathe]
 * @property {string} [leanAxis] "fb" for a forward/back bake
 * @property {string} [pose]
 * @property {MikuClose} [close] the close-up's atlas, close.rgba
 */
/**
 * The close-up in atlas.json (tools/live2d_bake bakeClose).
 * @typedef {object} MikuClose
 * @property {number[]} atlas [w, h] of close.rgba
 * @property {number[]} frame [w, h]
 * @property {number} zoomSteps
 * @property {number} turnSteps
 * @property {number[]} grid cell w, h, columns, pad
 * @property {number[]} cropGrid cell w, h, columns, y of the first row
 * @property {number[]} crop the eyes' rect in a frame
 * @property {Array<number[]>} rects each zoom step's camera and the close-up's, standing frame px
 * @property {number[]} pivot
 * @property {number[]} swayAngle
 * @property {number[]} turnShift
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
 * The Miku shader's tables as pixel rows to go under the atlas art: 32 entries of two values each, each entry a 3x3 px
 * block (so a bilinear read at its middle gets it whole), opaque (alpha 255: a canvas or driver that premultiplies
 * leaves it alone), each value 12 bits: (v + 1024) * 2 in R (high 8) and B's high or low nibble, in G likewise:
 * -1024 .. 1023.5 px in half px. Entries: 0-15 the lean frames' atlas x, y; 16-31 each lean frame's head shift x, y
 * (y: the forward/back lean's head drop; 0 sideways). Returns { px, rows, counts: { lean } }.
 * @param {MikuInfo} info atlas.json
 * @param {number} atlasWidth the atlas width, px
 * @returns {{ px: Buffer, rows: number, counts: MikuCounts }}
 */
function mikuData(info, atlasWidth) {
  /** @type {(pair: *) => number[]} */
  const xy = (pair) =>
      Array.isArray(pair)
        ? [Number(pair[0]) || 0, Number(pair[1]) || 0]
        : [0, 0],
    /** @type {(list: *, i: number) => number} */
    num = (list, i) => (Array.isArray(list) && isNum(list[i]) ? list[i] : 0);
  const lean =
    Array.isArray(info.lean) && info.lean.length >= 3
      ? info.lean.slice(0, 15)
      : [info.frames.idle];
  const entries = [];
  for (let i = 0; i < 16; i++) entries[i] = xy(lean[i]);
  for (let i = 0; i < 16; i++)
    entries[16 + i] = [num(info.leanShift, i), num(info.leanShiftY, i)];
  const per = Math.floor(atlasWidth / 3),
    rows = Math.ceil(entries.length / per) * 3,
    pixels = Buffer.alloc(atlasWidth * rows * 4, 0);
  /** @type {(value: number) => number} */
  const quantize = (value) =>
    Math.max(0, Math.min(4095, Math.round((value + 1024) * 2)));
  entries.forEach((entry, i) => {
    const codeX = quantize(entry[0]),
      codeY = quantize(entry[1]),
      x0 = (i % per) * 3,
      y0 = Math.floor(i / per) * 3;
    for (let dy = 0; dy < 3; dy++)
      for (let dx = 0; dx < 3; dx++) {
        const offset = ((y0 + dy) * atlasWidth + x0 + dx) * 4;
        pixels[offset] = codeX >> 4;
        pixels[offset + 1] = codeY >> 4;
        pixels[offset + 2] = ((codeX & 15) << 4) | (codeY & 15);
        pixels[offset + 3] = 255;
      }
  });
  return {
    px: pixels,
    rows,
    counts: { lean: lean.length },
  };
}

/**
 * The Miku layout's baked frames: <data>/miku/atlas.json and
 * atlas.rgba (straight-alpha RGBA, atlas[0] x atlas[1] px), made by tools/live2d_bake and pushed by
 * scripts/deploy.sh --miku. They are not in the app: the character's art stays with its owner. Uploaded once as an
 * RGBA asset per connection and kept in hud.atlases (so the pixel memory counts it); new files (a later bake)
 * drop the old asset. Null, with hud.problem set, when the files are missing or bad.
 * @param {import("../../engine/app").App} hud
 * @param {Widget} widget
 * @param {number} connIndex connection index
 * @returns {?SpriteAtlas}
 */
function sprite(hud, widget, connIndex) {
  // the HUD's Miku from miku/ (a forward/back lean bake, lean.axis "fb", works there too: its leanAxis turns
  // the arms' balance off)
  const sub = "miku",
    dir = path.join(hud.ctx.dataDir || ".", sub);
  let stat;
  try {
    stat = fs.statSync(path.join(dir, "atlas.rgba"));
  } catch (err) {
    stat = null;
  }
  const pre = "sprite:" + connIndex + ":",
    key = pre + dir + ":" + (stat ? stat.mtimeMs : 0);
  if (hud.atlases.has(key)) return hud.atlases.get(key);
  // another bake (or a newer file) on this connection: drop the old asset before uploading, so one is in the
  // pixel memory at a time. Swapping this way while running works on the car (Nov 9 2026: Custom HUD 0.1.18's
  // Miku lean setting swapped her 1024x564 atlas between the sideways and fb bakes and the new frames showed)
  hud.atlases.forEach((atlas, k) => {
    if (k.indexOf(pre) === 0) {
      atlas.c.drop(atlas.ref);
      hud.atlases.delete(k);
    }
  });
  try {
    if (!stat)
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
    const [atlasWidth, atlasHeight] = info.atlas || [];
    if (!(atlasWidth > 0 && atlasHeight > 0))
      throw new Error('atlas.json: bad "atlas" size');
    // the instrument cluster (KOMBI) restarted on a 1024x1128 RGBA asset (Nov 2026): nothing over 1024 a side
    if (atlasWidth > 1024 || atlasHeight > 1024)
      throw new Error(
        "atlas " +
          atlasWidth +
          "x" +
          atlasHeight +
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
    if (art.length !== atlasWidth * atlasHeight * 4)
      throw new Error(
        "atlas.rgba is " +
          art.length +
          " bytes, " +
          atlasWidth +
          "x" +
          atlasHeight +
          " RGBA needs " +
          atlasWidth * atlasHeight * 4,
      );
    // the per-frame tables go in a few rows under the art, which the shader reads (mikuData), not in uniforms
    if (info.pose)
      throw new Error(
        "atlas.json is a " +
          info.pose +
          " bake (no layout draws one now): bake the standing one",
      );
    const data = mikuData(info, atlasWidth),
      height = atlasHeight + data.rows;
    if (height > 1024)
      throw new Error(
        "atlas " +
          atlasWidth +
          "x" +
          atlasHeight +
          " leaves no room under 1024 px for its " +
          data.rows +
          " rows of tables; bake again with the current tools/live2d_bake",
      );
    const pixels = Buffer.concat([art, data.px]);
    const client = hud._clientAt(connIndex);
    const ref = client.asset({
      target: hud.target,
      format: "rgba8",
      w: atlasWidth,
      h: height,
      sampling: "bilinear",
    });
    if (!ref)
      throw new Error(
        "atlas asset refused (" + atlasWidth + "x" + height + ")",
      );
    client.pixels(ref, null, pixels);
    const atlas = {
      ref,
      c: client,
      ci: connIndex,
      info,
      size: [atlasWidth, height],
      dataY: atlasHeight,
      counts: data.counts,
      bytes: atlasWidth * height * 8,
    };
    hud.atlases.set(key, atlas);
    hud.log.info(
      "miku frames: " +
        Object.keys(info.frames).length +
        " of " +
        info.frame.join("x") +
        ", " +
        (info.tails ? "tails, " : "") +
        atlasWidth +
        "x" +
        height +
        " RGBA asset, " +
        mib(atlas.bytes) +
        " of pixel memory",
    );
    return atlas;
  } catch (err) {
    hud.problem = "Miku: " + err.message;
    hud.log.warn('widget "' + widget.id + '": ' + err.message);
    return null;
  }
}

/**
 * The close-up's atlas (<data>/miku/close.rgba, tools/live2d_bake's bakeClose, described by atlas.json's "close"),
 * uploaded once per connection as an RGBA asset of its own and kept in hud.atlases like the standing one. Null when
 * the bake has no close-up or close.rgba is missing or bad: the reason is logged and she just stands, no zoom.
 * @param {HudApp} hud
 * @param {SpriteAtlas} standing the standing atlas (sprite()), whose atlas.json says what close.rgba holds
 * @param {number} connIndex connection index
 * @returns {?SpriteAtlas}
 */
function closeSprite(hud, standing, connIndex) {
  const close = standing.info.close;
  if (!close) return null;
  const dir = path.join(hud.ctx.dataDir || ".", "miku"),
    file = path.join(dir, "close.rgba");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    hud.log.warn("miku close-up: no " + file + " (deploy the bake again)");
    return null;
  }
  const pre = "closeup:" + connIndex + ":",
    key = pre + dir + ":" + stat.mtimeMs;
  if (hud.atlases.has(key)) return hud.atlases.get(key);
  hud.atlases.forEach((atlas, k) => {
    if (k.indexOf(pre) === 0) {
      atlas.c.drop(atlas.ref);
      hud.atlases.delete(k);
    }
  });
  try {
    const [w, h] = close.atlas || [];
    if (!(w > 0 && h > 0) || w > 1024 || h > 1024)
      throw new Error("bad close.atlas size " + w + "x" + h);
    const pixels = fs.readFileSync(file);
    if (pixels.length !== w * h * 4)
      throw new Error(
        "close.rgba is " +
          pixels.length +
          " bytes, " +
          w +
          "x" +
          h +
          " RGBA needs " +
          w * h * 4,
      );
    const client = hud._clientAt(connIndex);
    const ref = client.asset({
      target: hud.target,
      format: "rgba8",
      w,
      h,
      sampling: "bilinear",
    });
    if (!ref) throw new Error("asset refused (" + w + "x" + h + ")");
    client.pixels(ref, null, pixels);
    const atlas = {
      ref,
      c: client,
      ci: connIndex,
      info: standing.info,
      size: [w, h],
      dataY: h,
      counts: standing.counts,
      bytes: w * h * 8,
    };
    hud.atlases.set(key, atlas);
    hud.log.info(
      "miku close-up: " +
        close.zoomSteps +
        " zoom steps, " +
        (3 + 2 * close.turnSteps) +
        " poses of " +
        close.frame.join("x") +
        ", " +
        w +
        "x" +
        h +
        " RGBA asset, " +
        mib(atlas.bytes) +
        " of pixel memory",
    );
    return atlas;
  } catch (err) {
    hud.log.warn("miku close-up: " + err.message);
    return null;
  }
}

module.exports = { sprite, closeSprite, mikuData };
