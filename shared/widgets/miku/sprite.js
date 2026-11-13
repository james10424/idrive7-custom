"use strict";
/**
 * The Miku character's baked frames (tools/live2d_bake), loaded from the app's data folder and uploaded as ETC2 RGBA
 * assets (cluster-render's etc2rgba, 0.5.9 on: a quarter of RGBA8's pixel memory), the standing shader's tables in a
 * small RGBA8 asset beside its atlas.
 */
const fs = require("fs");
const path = require("path");
const { isNum, mib } = require("../../engine/util");

const MAX_SIDE_PX = 1024; // the KOMBI restarted on a 1024x1128 asset: nothing over this a side
// the close-up's atlas: 2048x2048 ETC2 draws on the HUD and the cluster, seven at once (car tests, Nov 13 2026; the
// 1024x1128 restart was the shader's reads, not the atlas), so it may be 2048 a side (more turn frames)
const CLOSE_MAX_SIDE_PX = 2048;
const MIN_LEAN_FRAMES = 3; // fewer lean frames than this: only the idle frame
const MAX_LEAN_FRAMES = 15; // lean frames read from a bake, at most
const TABLE_ENTRIES = 16; // entries in each of the two tables (lean frames, head shifts)
const BLOCK_PX = 3; // each entry is a 3x3 px block
const CODE_OFFSET_PX = 1024; // a table value's code is (v + this) * 2, so -1024 .. 1023.5 px fit
const CODE_MAX = 4095; // the code's 12 bits
const PIXEL_MEM_BYTES = 8; // pixel memory counted per RGBA8 asset px (as the engine counts it: 4 bytes, twice)
const ETC2_MEM_BYTES = 1; // and per ETC2 asset px (1 byte, charged once: no rectangle scratch, cluster-render PROTOCOL.md)
const ETC2_BLOCK_PX = 4,
  ETC2_BLOCK_BYTES = 16;
/** Bytes of a w x h ETC2 RGBA image. @param {number} w @param {number} h */
const etc2Bytes = (w, h) => (w / ETC2_BLOCK_PX) * (h / ETC2_BLOCK_PX) * ETC2_BLOCK_BYTES;
/**
 * Why a w x h ETC2 atlas file of n bytes is bad, or "".
 * @param {string} name @param {number} n @param {number} w @param {number} h
 * @returns {string}
 */
function etc2Problem(name, n, w, h) {
  if (w % ETC2_BLOCK_PX || h % ETC2_BLOCK_PX)
    return name + " is " + w + "x" + h + ", not whole 4x4 blocks: bake again with the current tools/live2d_bake";
  if (n !== etc2Bytes(w, h)) return name + " is " + n + " bytes, " + w + "x" + h + " ETC2 needs " + etc2Bytes(w, h);
  return "";
}

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
 * @property {MikuClose} [close] the close-up's atlas, close.etc2
 */
/**
 * The close-up in atlas.json (tools/live2d_bake bakeClose).
 * @typedef {object} MikuClose
 * @property {number[]} atlas [w, h] of close.etc2
 * @property {number[]} frame [w, h]
 * @property {number} zoomSteps
 * @property {number} turnSteps
 * @property {number[]} grid cell w, h, columns, pad
 * @property {number[]} cropGrid cell w, h, columns, y of the first row
 * @property {number[]} crop the eyes' rect in a frame
 * @property {Array<number[]>} rects each zoom step's camera and the close-up's, standing frame px
 * @property {number[]} pivot
 * @property {number[]} swayAngle
 * @property {number[]} turnShift the turn's head shifts, then (close.only) the lean's
 * @property {boolean} [only] close.only: no standing figure or zoom
 * @property {number} [leanSteps] close.only: the lean's steps each way
 * @property {{ atlas: number[], cropY: number }} [leanAtlas] close.only: the lean's own atlas (lean.etc2), on the
 *   close-up's grid with its crops from cropY
 * @property {*} [idle] close.only: the idle loop's atlas (idle.etc2)
 */
/**
 * The Miku frames as an ETC2 asset on a connection (_sprite).
 * @typedef {object} SpriteAtlas
 * @property {number} ref
 * @property {number} [tableRef] the standing atlas's tables (RGBA8; u_table)
 * @property {number} [idleRef] the close-up's idle loop (a close.idle bake; u_idle)
 * @property {number[]} [idleSize] its [w, h]
 * @property {number} [leanRef] the close-up's lean (a close.only bake's driving set, lean.etc2; u_leanAtlas)
 * @property {number[]} [leanSize] its [w, h]
 * @property {Client} c
 * @property {number} ci
 * @property {MikuInfo} info
 * @property {number[]} size [w, h] with the table rows
 * @property {number} dataY the standing atlas: its table asset's height (px)
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
    Array.isArray(info.lean) && info.lean.length >= MIN_LEAN_FRAMES
      ? info.lean.slice(0, MAX_LEAN_FRAMES)
      : [info.frames.idle];
  const entries = [];
  for (let i = 0; i < TABLE_ENTRIES; i++) entries[i] = xy(lean[i]);
  for (let i = 0; i < TABLE_ENTRIES; i++)
    entries[TABLE_ENTRIES + i] = [num(info.leanShift, i), num(info.leanShiftY, i)];
  const per = Math.floor(atlasWidth / BLOCK_PX),
    rows = Math.ceil(entries.length / per) * BLOCK_PX,
    pixels = Buffer.alloc(atlasWidth * rows * 4, 0);
  /** @type {(value: number) => number} */
  const quantize = (value) =>
    Math.max(0, Math.min(CODE_MAX, Math.round((value + CODE_OFFSET_PX) * 2)));
  entries.forEach((entry, i) => {
    const codeX = quantize(entry[0]),
      codeY = quantize(entry[1]),
      x0 = (i % per) * BLOCK_PX,
      y0 = Math.floor(i / per) * BLOCK_PX;
    for (let dy = 0; dy < BLOCK_PX; dy++)
      for (let dx = 0; dx < BLOCK_PX; dx++) {
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
 * atlas.etc2 (ETC2 RGBA of the straight-alpha art, atlas[0] x atlas[1] px), made by tools/live2d_bake and pushed by
 * scripts/deploy.sh --miku. They are not in the app: the character's art stays with its owner. Uploaded once per
 * connection as an etc2rgba asset, with the per-frame tables (exact values, which ETC2 would blur) in a small RGBA8
 * asset of their own, and kept in hud.atlases (so the pixel memory counts them); new files (a later bake) drop the
 * old assets. Null, with hud.problem set, when the files are missing or bad.
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
    stat = fs.statSync(path.join(dir, "atlas.etc2"));
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
      if (atlas.tableRef) atlas.c.drop(atlas.tableRef);
      hud.atlases.delete(k);
    }
  });
  try {
    if (!stat)
      throw new Error(
        "no baked frames in " +
          dir +
          (fs.existsSync(path.join(dir, "atlas.rgba"))
            ? " in ETC2 (an older bake: bake again with the current tools/live2d_bake"
            : " (tools/live2d_bake") +
          ", then scripts/deploy.sh --" +
          sub +
          ")",
      );
    const info = JSON.parse(
      fs.readFileSync(path.join(dir, "atlas.json"), "utf8"),
    );
    const [atlasWidth, atlasHeight] = info.atlas || [];
    if (!(atlasWidth > 0 && atlasHeight > 0))
      throw new Error('atlas.json: bad "atlas" size');
    // the instrument cluster (KOMBI) restarted with a 1024x1128 RGBA asset (Nov 2026; the shader was later found to
    // be the cause, but 2048 is untested): nothing over 1024 a side
    if (atlasWidth > MAX_SIDE_PX || atlasHeight > MAX_SIDE_PX)
      throw new Error(
        "atlas " +
          atlasWidth +
          "x" +
          atlasHeight +
          " is over " +
          MAX_SIDE_PX +
          " px a side, which restarts the instrument cluster; bake again with the current tools/live2d_bake",
      );
    if (
      !info.frames ||
      !info.frames.idle ||
      !Array.isArray(info.frame) ||
      !Array.isArray(info.anchor)
    )
      throw new Error('atlas.json: needs "frame", "anchor" and frames.idle');
    const art = fs.readFileSync(path.join(dir, "atlas.etc2"));
    const bad = etc2Problem("atlas.etc2", art.length, atlasWidth, atlasHeight);
    if (bad) throw new Error(bad);
    if (info.pose)
      throw new Error(
        "atlas.json is a " +
          info.pose +
          " bake (no layout draws one now): bake the standing one",
      );
    // the per-frame tables, which the shader reads (mikuData), in an RGBA8 asset of their own as wide as the atlas
    const data = mikuData(info, atlasWidth);
    // a close.only bake: the standing frames aren't drawn, so they don't go up (the close-up's atlas is all of her)
    if (info.close && info.close.only) {
      const none = { ref: 0, c: hud._clientAt(connIndex), ci: connIndex, info, size: [atlasWidth, atlasHeight],
        dataY: data.rows, counts: data.counts, bytes: 0 };
      hud.atlases.set(key, none);
      hud.log.info("miku: close-up only (its standing frames not uploaded)");
      return none;
    }
    const client = hud._clientAt(connIndex);
    const ref = client.asset({
      target: hud.target,
      format: "etc2rgba",
      w: atlasWidth,
      h: atlasHeight,
      sampling: "bilinear",
    });
    if (!ref)
      throw new Error("atlas asset refused (" + atlasWidth + "x" + atlasHeight + " ETC2)");
    const tableRef = client.asset({
      target: hud.target,
      format: "rgba8",
      w: atlasWidth,
      h: data.rows,
      sampling: "nearest",
    });
    if (!tableRef) {
      client.drop(ref);
      throw new Error("table asset refused (" + atlasWidth + "x" + data.rows + ")");
    }
    client.pixels(ref, null, art);
    client.pixels(tableRef, null, data.px);
    const atlas = {
      ref,
      tableRef,
      c: client,
      ci: connIndex,
      info,
      size: [atlasWidth, atlasHeight],
      dataY: data.rows,
      counts: data.counts,
      bytes: atlasWidth * atlasHeight * ETC2_MEM_BYTES + atlasWidth * data.rows * PIXEL_MEM_BYTES,
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
        atlasHeight +
        " ETC2 asset and its " +
        atlasWidth +
        "x" +
        data.rows +
        " tables, " +
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
 * The close-up's atlas (<data>/miku/close.etc2, ETC2 RGBA, tools/live2d_bake's bakeClose, described by atlas.json's
 * "close"), uploaded once per connection as an etc2rgba asset of its own and kept in hud.atlases like the standing one. Null when
 * the bake has no close-up or close.etc2 is missing or bad: the reason is logged and she just stands, no zoom.
 * @param {HudApp} hud
 * @param {SpriteAtlas} standing the standing atlas (sprite()), whose atlas.json says what close.etc2 holds
 * @param {number} connIndex connection index
 * @returns {?SpriteAtlas}
 */
function closeSprite(hud, standing, connIndex) {
  const close = standing.info.close;
  if (!close) return null;
  const dir = path.join(hud.ctx.dataDir || ".", "miku"),
    file = path.join(dir, "close.etc2");
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
      if (atlas.idleRef) atlas.c.drop(atlas.idleRef);
      if (atlas.leanRef) atlas.c.drop(atlas.leanRef);
      hud.atlases.delete(k);
    }
  });
  try {
    const [w, h] = close.atlas || [];
    if (!(w > 0 && h > 0) || w > CLOSE_MAX_SIDE_PX || h > CLOSE_MAX_SIDE_PX)
      throw new Error("bad close.atlas size " + w + "x" + h);
    const pixels = fs.readFileSync(file);
    const bad = etc2Problem("close.etc2", pixels.length, w, h);
    if (bad) throw new Error(bad);
    const client = hud._clientAt(connIndex);
    const ref = client.asset({
      target: hud.target,
      format: "etc2rgba",
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
      bytes: w * h * ETC2_MEM_BYTES,
    };
    // a close.only bake with a lean: the driving set's own atlas, lean.etc2 (u_leanAtlas); without it she can't drive
    const leanAtlas = close.leanAtlas;
    if (leanAtlas) {
      const lw = (leanAtlas.atlas || [])[0],
        lh = (leanAtlas.atlas || [])[1];
      let leanBytes = null;
      try {
        leanBytes = fs.readFileSync(path.join(dir, "lean.etc2"));
      } catch (err) {
        /* named below */
      }
      const badLean = !leanBytes
        ? "no lean.etc2 (deploy the bake again)"
        : !(lw > 0 && lh > 0) || lw > CLOSE_MAX_SIDE_PX || lh > CLOSE_MAX_SIDE_PX
          ? "bad close.leanAtlas size " + lw + "x" + lh
          : etc2Problem("lean.etc2", leanBytes.length, lw, lh);
      if (badLean) {
        client.drop(ref);
        throw new Error(badLean);
      }
      const leanRef = client.asset({ target: hud.target, format: "etc2rgba", w: lw, h: lh, sampling: "bilinear" });
      if (!leanRef) {
        client.drop(ref);
        throw new Error("lean asset refused (" + lw + "x" + lh + ")");
      }
      client.pixels(leanRef, null, /** @type {Buffer} */ (leanBytes));
      atlas.leanRef = leanRef;
      atlas.leanSize = [lw, lh];
      atlas.bytes += lw * lh * ETC2_MEM_BYTES;
      hud.log.info("miku lean: " + (2 * close.leanSteps + 1) + " frames, " + lw + "x" + lh + " ETC2 asset");
    }
    // a close.idle bake: the stopped idle loop's own atlas, idle.etc2, a second asset (u_idle)
    const idle = close.idle;
    if (idle) {
      const iw = (idle.atlas || [])[0],
        ih = (idle.atlas || [])[1];
      let idleBytes = null;
      try {
        idleBytes = fs.readFileSync(path.join(dir, "idle.etc2"));
      } catch (err) {
        /* named below */
      }
      const badIdle = !idleBytes
        ? "no idle.etc2 (deploy the bake again)"
        : !(iw > 0 && ih > 0) || iw > CLOSE_MAX_SIDE_PX || ih > CLOSE_MAX_SIDE_PX
          ? "bad close.idle.atlas size " + iw + "x" + ih
          : etc2Problem("idle.etc2", idleBytes.length, iw, ih);
      if (badIdle) hud.log.warn("miku idle: " + badIdle + "; she stands upright when stopped");
      else {
        const idleRef = client.asset({ target: hud.target, format: "etc2rgba", w: iw, h: ih, sampling: "bilinear" });
        if (idleRef) {
          client.pixels(idleRef, null, /** @type {Buffer} */ (idleBytes));
          atlas.idleRef = idleRef;
          atlas.idleSize = [iw, ih];
          atlas.bytes += iw * ih * ETC2_MEM_BYTES;
          hud.log.info("miku idle: " + idle.count + " frames over " + idle.period + " s, " + iw + "x" + ih + " ETC2 asset");
        } else hud.log.warn("miku idle: asset refused (" + iw + "x" + ih + ")");
      }
    }
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
        " ETC2 asset, " +
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
