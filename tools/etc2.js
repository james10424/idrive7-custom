"use strict";
/**
 * ETC2 RGBA (GL_COMPRESSED_RGBA8_ETC2_EAC): 1 byte a pixel instead of RGBA8's 4, which the instrument cluster's GPU
 * draws (car test, Nov 12 2026; cluster-render's `etc2rgba` asset format). A port of idrive-apps'
 * native/cluster-render/tools/etc2_test/etc2_encode.py, whose output decoded byte for byte the same on a GPU.
 *
 * Each 4x4 block is 16 bytes: the EAC alpha block, then the colour block, both big-endian; blocks in rows, top to
 * bottom. Colour uses ETC1's individual and differential modes only (no T, H or planar), which every ETC2 decoder
 * reads as ETC2 blocks; differential deltas never overflow, so no block falls into T, H or planar by accident.
 * Colour error is weighted by alpha. Alpha is EAC: all 16 tables, multipliers 1-15.
 *
 * Used by tools/live2d_bake/serve.js (Miku's atlases after a bake) and bench/server.js (to show an etc2rgba asset).
 *
 *   node tools/etc2.js encode in.rgba W H out.etc2
 *   node tools/etc2.js decode in.etc2 W H out.rgba
 */

const BLOCK = 4; // px a side
const BLOCK_BYTES = 16;
const ETC1_TABLES = [
  [2, 8],
  [5, 17],
  [9, 29],
  [13, 42],
  [18, 60],
  [24, 80],
  [33, 106],
  [47, 183],
];
// a pixel's modifier index m (msb << 1 | lsb): 0 +a, 1 +b, 2 -a, 3 -b
const ETC1_MODS = ETC1_TABLES.map(([a, b]) => [a, b, -a, -b]);
const EAC_TABLES = [
  [-3, -6, -9, -15, 2, 5, 8, 14],
  [-3, -7, -10, -13, 2, 6, 9, 12],
  [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11],
  [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10],
  [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9],
  [-2, -4, -8, -10, 1, 3, 7, 9],
  [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9],
  [-1, -2, -3, -10, 0, 1, 2, 9],
  [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8],
];
const EAC_FLAT_TABLE = 13, // a one-value block: table 13 has 0 at index 4
  EAC_FLAT_INDEX = 4,
  EAC_MULTS = 15,
  EAC_BASE_SEARCH = 3; // bases tried each side of the centre
// a block's pixels in index order: i = x * 4 + y
const PIXELS = 16;
// sub-blocks as pixel indices: flip 0 left and right 2x4, flip 1 top and bottom 4x2
const SUBS = [
  [range16((i) => i >> 2 < 2), range16((i) => i >> 2 >= 2)],
  [range16((i) => i % 4 < 2), range16((i) => i % 4 >= 2)],
];
const ALPHA_WEIGHT_FLOOR = 0.002; // a transparent pixel's colour still counts a little
const DIFF_MIN = -4,
  DIFF_MAX = 3;
const Q4_MAX = 15,
  Q5_MAX = 31,
  Q4_SCALE = 17; // 4-bit 0..15 to 0..255

/** @param {(i: number) => boolean} keep @returns {number[]} */
function range16(keep) {
  const out = [];
  for (let i = 0; i < PIXELS; i++) if (keep(i)) out.push(i);
  return out;
}
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** @param {number} q a 5-bit channel @returns {number} 0..255 */
const expand5 = (q) => (q << 3) | (q >> 2);

/**
 * The best table and modifiers for one sub-block at a base colour.
 * @param {Float64Array} px the sub-block's 8 pixels, r g b
 * @param {Float64Array} w their weights
 * @param {number[]} base r g b, 0..255
 * @returns {{ err: number, table: number, idx: number[] }}
 */
function subBest(px, w, base) {
  let best = { err: Infinity, table: 0, idx: /** @type {number[]} */ ([]) };
  for (let t = 0; t < ETC1_MODS.length; t++) {
    let err = 0;
    const idx = [];
    for (let p = 0; p < 8 && err < best.err; p++) {
      let pe = Infinity,
        pm = 0;
      for (let m = 0; m < 4; m++) {
        const mod = ETC1_MODS[t][m];
        let e = 0;
        for (let c = 0; c < 3; c++) {
          const d = px[p * 3 + c] - clamp(base[c] + mod, 0, 255);
          e += d * d;
        }
        if (e < pe) {
          pe = e;
          pm = m;
        }
      }
      err += pe * w[p];
      idx.push(pm);
    }
    if (err < best.err) best = { err, table: t, idx };
  }
  return best;
}

/**
 * One block's colour, 8 bytes.
 * @param {Uint8Array} rgba the block's 16 pixels in index order, RGBA
 * @returns {Buffer}
 */
function encodeColor(rgba) {
  /** @type {{ err: number, flip: number, diff: number, c1: number[], c2: number[], t1: number, t2: number, i1: number[], i2: number[] } | null} */
  let best = null;
  for (let flip = 0; flip < 2; flip++) {
    const res = SUBS[flip].map((sub) => {
      const px = new Float64Array(24),
        w = new Float64Array(8);
      let ws = 0;
      const avg = [0, 0, 0];
      sub.forEach((p, k) => {
        w[k] = rgba[p * 4 + 3] / 255 + ALPHA_WEIGHT_FLOOR;
        ws += w[k];
        for (let c = 0; c < 3; c++) {
          px[k * 3 + c] = rgba[p * 4 + c];
          avg[c] += rgba[p * 4 + c] * w[k];
        }
      });
      for (let c = 0; c < 3; c++) avg[c] /= ws;
      // the 27 bases round the average, in 4 bits (individual) and 5 bits (differential)
      const q4 = [],
        q5 = [];
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (let d = -1; d <= 1; d++) {
            const off = [a, b, d];
            q4.push(avg.map((v, c) => clamp(Math.round(v / Q4_SCALE) + off[c], 0, Q4_MAX)));
            q5.push(avg.map((v, c) => clamp(Math.round((v * Q5_MAX) / 255) + off[c], 0, Q5_MAX)));
          }
      return {
        q4,
        b4: q4.map((q) => subBest(px, w, q.map((v) => v * Q4_SCALE))),
        q5,
        b5: q5.map((q) => subBest(px, w, q.map(expand5))),
      };
    });
    // individual: each sub-block on its own
    const pick = (/** @type {{ err: number }[]} */ list) =>
      list.reduce((bi, e, i) => (e.err < list[bi].err ? i : bi), 0);
    const k1 = pick(res[0].b4),
      k2 = pick(res[1].b4);
    const indErr = res[0].b4[k1].err + res[1].b4[k2].err;
    if (!best || indErr < best.err)
      best = {
        err: indErr,
        flip,
        diff: 0,
        c1: res[0].q4[k1],
        c2: res[1].q4[k2],
        t1: res[0].b4[k1].table,
        t2: res[1].b4[k2].table,
        i1: res[0].b4[k1].idx,
        i2: res[1].b4[k2].idx,
      };
    // differential: pairs whose delta is -4..3 in every channel
    let dErr = Infinity,
      d1 = -1,
      d2 = -1;
    for (let a = 0; a < res[0].q5.length; a++)
      for (let b = 0; b < res[1].q5.length; b++) {
        const qa = res[0].q5[a],
          qb = res[1].q5[b];
        let ok = true;
        for (let c = 0; c < 3; c++) {
          const dl = qb[c] - qa[c];
          if (dl < DIFF_MIN || dl > DIFF_MAX) ok = false;
        }
        if (!ok) continue;
        const e = res[0].b5[a].err + res[1].b5[b].err;
        if (e < dErr) {
          dErr = e;
          d1 = a;
          d2 = b;
        }
      }
    if (d1 >= 0 && dErr < best.err)
      best = {
        err: dErr,
        flip,
        diff: 1,
        c1: res[0].q5[d1],
        c2: res[1].q5[d2],
        t1: res[0].b5[d1].table,
        t2: res[1].b5[d2].table,
        i1: res[0].b5[d1].idx,
        i2: res[1].b5[d2].idx,
      };
  }
  const b = /** @type {NonNullable<typeof best>} */ (best);
  // the high word: base colours, tables, diff and flip bits; the low word: each pixel's modifier msb (16 + p), lsb (p)
  let hi = 0;
  for (let c = 0; c < 3; c++)
    hi |= (b.diff ? (b.c1[c] << 3) | ((b.c2[c] - b.c1[c]) & 7) : (b.c1[c] << 4) | b.c2[c]) << (24 - 8 * c);
  hi |= (b.t1 << 5) | (b.t2 << 2) | (b.diff << 1) | b.flip;
  let lo = 0;
  SUBS[b.flip].forEach((sub, s) =>
    sub.forEach((p, k) => {
      const m = (s ? b.i2 : b.i1)[k];
      lo |= ((m >> 1) << (16 + p)) | ((m & 1) << p);
    }),
  );
  const out = Buffer.alloc(8);
  out.writeUInt32BE(hi >>> 0, 0);
  out.writeUInt32BE(lo >>> 0, 4);
  return out;
}

/**
 * One block's alpha, 8 bytes (EAC).
 * @param {Uint8Array} rgba the block's 16 pixels in index order, RGBA
 * @returns {Buffer}
 */
function encodeAlpha(rgba) {
  const a = [];
  for (let p = 0; p < PIXELS; p++) a.push(rgba[p * 4 + 3]);
  const mn = Math.min(...a),
    mx = Math.max(...a);
  let base = mn,
    mul = 1,
    tab = EAC_FLAT_TABLE,
    idx = a.map(() => EAC_FLAT_INDEX);
  if (mn !== mx) {
    let bestErr = Infinity;
    for (let t = 0; t < EAC_TABLES.length; t++) {
      const table = EAC_TABLES[t],
        span = Math.min(...table) + Math.max(...table);
      for (let m = 1; m <= EAC_MULTS; m++) {
        const centre = Math.round((mn + mx) / 2 - (span * m) / 2);
        for (let k = -EAC_BASE_SEARCH; k <= EAC_BASE_SEARCH; k++) {
          const b = clamp(centre + k, 0, 255);
          const vals = table.map((v) => clamp(b + v * m, 0, 255));
          let err = 0;
          const ids = [];
          for (let p = 0; p < PIXELS && err < bestErr; p++) {
            let pe = Infinity,
              pj = 0;
            for (let j = 0; j < 8; j++) {
              const d = a[p] - vals[j];
              if (d * d < pe) {
                pe = d * d;
                pj = j;
              }
            }
            err += pe;
            ids.push(pj);
          }
          if (err < bestErr) {
            bestErr = err;
            base = b;
            mul = m;
            tab = t;
            idx = ids;
          }
        }
      }
    }
  }
  // base 8 bits, multiplier 4, table 4, then 16 indices of 3 bits: 48 bits after the first 16
  const out = Buffer.alloc(8);
  out[0] = base;
  out[1] = (mul << 4) | tab;
  let bits = 0n;
  for (let p = 0; p < PIXELS; p++) bits |= BigInt(idx[p]) << BigInt(45 - 3 * p);
  for (let k = 0; k < 6; k++) out[2 + k] = Number((bits >> BigInt(40 - 8 * k)) & 0xffn);
  return out;
}

/** A fully transparent black block: alpha flat 0, colour 0 (individual, table 0, every pixel -2, clamped to 0). */
const CLEAR_BLOCK = (() => {
  const out = Buffer.alloc(BLOCK_BYTES);
  out[1] = (1 << 4) | EAC_FLAT_TABLE;
  let bits = 0n;
  for (let p = 0; p < PIXELS; p++) bits |= BigInt(EAC_FLAT_INDEX) << BigInt(45 - 3 * p);
  for (let k = 0; k < 6; k++) out[2 + k] = Number((bits >> BigInt(40 - 8 * k)) & 0xffn);
  out.writeUInt32BE(0xffff0000 >>> 0, 12); // every pixel's msb: modifier -a
  return out;
})();

/**
 * Encodes RGBA (straight alpha, rows top to bottom) to ETC2 RGBA.
 * @param {Uint8Array} rgba w * h * 4 bytes
 * @param {number} w a multiple of 4
 * @param {number} h a multiple of 4
 * @returns {Buffer} (w / 4) * (h / 4) * 16 bytes
 */
function encode(rgba, w, h) {
  check(rgba, w, h);
  return encodeRows(rgba, w, 0, h / BLOCK);
}

/**
 * @param {Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 */
function check(rgba, w, h) {
  if (w % BLOCK || h % BLOCK) throw new Error("etc2: " + w + "x" + h + " is not whole 4x4 blocks");
  if (rgba.length !== w * h * 4) throw new Error("etc2: " + rgba.length + " bytes is not " + w + "x" + h + " RGBA");
}

/**
 * Block rows by0 .. by1 (exclusive) of a w-wide RGBA image, as encode() writes them.
 * @param {Uint8Array} rgba
 * @param {number} w
 * @param {number} by0
 * @param {number} by1
 * @returns {Buffer}
 */
function encodeRows(rgba, w, by0, by1) {
  const bw = w / BLOCK,
    out = Buffer.alloc(bw * (by1 - by0) * BLOCK_BYTES),
    block = new Uint8Array(PIXELS * 4);
  for (let by = by0; by < by1; by++)
    for (let bx = 0; bx < bw; bx++) {
      let empty = true;
      for (let p = 0; p < PIXELS; p++) {
        const x = bx * BLOCK + (p >> 2),
          y = by * BLOCK + (p % 4),
          s = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) block[p * 4 + c] = rgba[s + c];
        if (rgba[s] || rgba[s + 1] || rgba[s + 2] || rgba[s + 3]) empty = false;
      }
      const at = ((by - by0) * bw + bx) * BLOCK_BYTES;
      if (empty) CLEAR_BLOCK.copy(out, at);
      else {
        encodeAlpha(block).copy(out, at);
        encodeColor(block).copy(out, at + 8);
      }
    }
  return out;
}

/**
 * Decodes ETC2 RGBA as written by encode() (individual and differential colour blocks only).
 * @param {Uint8Array} data
 * @param {number} w
 * @param {number} h
 * @returns {Buffer} w * h * 4 bytes RGBA
 */
function decode(data, w, h) {
  const bw = w / BLOCK,
    bh = h / BLOCK,
    out = Buffer.alloc(w * h * 4),
    buf = Buffer.from(data.buffer, data.byteOffset, data.length);
  if (buf.length !== bw * bh * BLOCK_BYTES) throw new Error("etc2: " + buf.length + " bytes is not " + w + "x" + h);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const at = (by * bw + bx) * BLOCK_BYTES;
      const base = buf[at],
        mul = buf[at + 1] >> 4,
        tab = buf[at + 1] & 15;
      let abits = 0n;
      for (let k = 0; k < 6; k++) abits = (abits << 8n) | BigInt(buf[at + 2 + k]);
      const hi = buf.readUInt32BE(at + 8),
        lo = buf.readUInt32BE(at + 12);
      const diff = (hi >> 1) & 1,
        flip = hi & 1,
        tabs = [(hi >> 5) & 7, (hi >> 2) & 7];
      /** @type {number[][]} */
      let cols;
      if (diff) {
        const c1 = [0, 1, 2].map((c) => (hi >>> (27 - 8 * c)) & 31);
        const d = [0, 1, 2].map((c) => {
          const v = (hi >>> (24 - 8 * c)) & 7;
          return v >= 4 ? v - 8 : v;
        });
        cols = [c1.map(expand5), c1.map((v, c) => expand5(v + d[c]))];
      } else
        cols = [
          [0, 1, 2].map((c) => ((hi >>> (28 - 8 * c)) & 15) * Q4_SCALE),
          [0, 1, 2].map((c) => ((hi >>> (24 - 8 * c)) & 15) * Q4_SCALE),
        ];
      SUBS[flip].forEach((sub, s) =>
        sub.forEach((p) => {
          const m = (((lo >>> (16 + p)) & 1) << 1) | ((lo >>> p) & 1);
          const x = bx * BLOCK + (p >> 2),
            y = by * BLOCK + (p % 4),
            o = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) out[o + c] = clamp(cols[s][c] + ETC1_MODS[tabs[s]][m], 0, 255);
          const j = Number((abits >> BigInt(45 - 3 * p)) & 7n);
          out[o + 3] = clamp(base + EAC_TABLES[tab][j] * mul, 0, 255);
        }),
      );
    }
  return out;
}

/** Bytes of a w x h ETC2 RGBA image. @param {number} w @param {number} h */
const etc2Bytes = (w, h) => (w / BLOCK) * (h / BLOCK) * BLOCK_BYTES;

/** Block rows a worker takes at a time: small enough to keep every core busy to the end. */
const ROWS_PER_JOB = 8;

/**
 * Encodes several images at once on worker threads (one per core by default), each split into runs of block rows:
 * the same bytes as encode() on each. The images go to the workers once, in shared memory.
 * @param {Array<{ rgba: Uint8Array, w: number, h: number }>} images
 * @param {number} [threads] default: the machine's cores
 * @returns {Promise<Buffer[]>}
 */
function encodeMany(images, threads) {
  const { Worker } = require("worker_threads");
  const n = Math.max(1, threads || require("os").cpus().length);
  images.forEach((img) => check(img.rgba, img.w, img.h));
  const shared = images.map((img) => {
    const sab = new SharedArrayBuffer(img.rgba.length);
    new Uint8Array(sab).set(img.rgba);
    return sab;
  });
  const outs = images.map((img) => Buffer.alloc(etc2Bytes(img.w, img.h)));
  /** @type {Array<{ i: number, by0: number, by1: number }>} */
  const jobs = [];
  images.forEach((img, i) => {
    for (let by = 0; by < img.h / BLOCK; by += ROWS_PER_JOB)
      jobs.push({ i, by0: by, by1: Math.min(img.h / BLOCK, by + ROWS_PER_JOB) });
  });
  if (!jobs.length) return Promise.resolve(outs);
  return new Promise((resolve, reject) => {
    let next = 0,
      done = 0,
      failed = false;
    const workers = [];
    for (let k = 0; k < Math.min(n, jobs.length); k++) {
      const worker = new Worker(__filename, { workerData: { images: shared, widths: images.map((img) => img.w) } });
      workers.push(worker);
      const give = () => {
        if (next < jobs.length) worker.postMessage(jobs[next++]);
        else worker.postMessage(null);
      };
      worker.on("message", (msg) => {
        const job = msg.job,
          bytes = images[job.i].w / BLOCK * BLOCK_BYTES;
        Buffer.from(msg.out).copy(outs[job.i], job.by0 * bytes);
        if (++done === jobs.length) {
          workers.forEach((other) => other.terminate());
          resolve(outs);
        } else give();
      });
      worker.on("error", (err) => {
        if (failed) return;
        failed = true;
        workers.forEach((other) => other.terminate());
        reject(err);
      });
      give();
    }
  });
}

module.exports = { encode, encodeMany, decode, etc2Bytes, BLOCK };

// an encodeMany worker: block rows of the shared images, as asked
const threads = require("worker_threads");
if (!threads.isMainThread && threads.workerData && threads.workerData.images) {
  const images = threads.workerData.images.map((/** @type {SharedArrayBuffer} */ sab) => new Uint8Array(sab)),
    widths = threads.workerData.widths;
  const port = /** @type {import("worker_threads").MessagePort} */ (threads.parentPort);
  port.on("message", (job) => {
    if (!job) return; // nothing left: it's terminated once every job is in
    const out = encodeRows(images[job.i], widths[job.i], job.by0, job.by1);
    port.postMessage({ job, out }, [out.buffer]);
  });
}

if (require.main === module && threads.isMainThread) {
  const fs = require("fs");
  const [cmd, input, ws, hs, output] = process.argv.slice(2);
  const w = Number(ws),
    h = Number(hs);
  if (cmd === "encode") fs.writeFileSync(output, encode(fs.readFileSync(input), w, h));
  else if (cmd === "decode") fs.writeFileSync(output, decode(fs.readFileSync(input), w, h));
  else {
    console.error("usage: node tools/etc2.js encode|decode <in> <w> <h> <out>");
    process.exit(1);
  }
}
