"use strict";
/**
 * Text in any script from a font file already on the car (the HMI's own), drawn at runtime: the baked atlases
 * (hud_text.js) only hold the few characters each readout needs, so a song title in Japanese or Greek needs the
 * car's font. opentype.js (MIT, vendored as opentype.js) reads the TrueType / OpenType outlines; the outlines are
 * filled here with an exact-area scanline rasterizer (after font-rs, Raph Levien, Apache-2.0 / MIT), pure JS for the
 * car's Node 8.
 *
 *   const f = sysfont.open(['/path/a.ttf', '/path/b.ttc'], log)  -> null when none loads
 *   f.mask(boxW, boxH, text, { size, align, baseline }) -> coverage Buffer (boxW*boxH), "…" when too wide
 *
 * Several files make a fallback chain: each character comes from the first font that has it. A .ttc/.otc
 * collection uses its first face. No shaping: scripts that need it (Arabic joining, Indic) draw letter by letter.
 */
const fs = require("fs");
/**
 * An opentype.js Font (the vendored ./opentype), as used here.
 * @typedef {any} OtFont
 */
/**
 * One loaded font file.
 * @typedef {{ path: string, font: OtFont }} FontFile
 */
/**
 * The font and glyph a character is drawn with; glyph null when no font has it.
 * @typedef {{ font: OtFont, glyph: any }} GlyphHit
 */
/**
 * @typedef {object} MaskOpts
 * @property {number} [size] px, default 0.75 x box height
 * @property {number} [baseline] px from the top, default 0.8 x size
 * @property {"left"|"center"|"right"} [align]
 */
/** @type {any} the opentype.js module, loaded on first use */
let opentype = null;

/** @returns {any} the opentype.js module */
function lib() {
  if (!opentype) opentype = require("./opentype");
  return opentype;
}

/** An ArrayBuffer of the first face of a font file (a collection's first face, its directory moved to the front). */
/**
 * @param {Buffer} buf
 * @returns {ArrayBuffer}
 */
function faceBuffer(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  if (buf.toString("latin1", 0, 4) !== "ttcf") return ab;
  // table offsets in a collection are from the file's start, so keep the file whole and copy the first face's
  // directory over the collection header (the header and the face directories come before any table data)
  const off = buf.readUInt32BE(12),
    n = buf.readUInt16BE(off + 4),
    len = 12 + 16 * n;
  const out = Buffer.from(buf);
  buf.copy(out, 0, off, off + len);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

/**
 * Opens font files as one fallback chain.
 * @param {string|string[]} paths
 * @param {import("./shift_score").Log} [log]
 * @returns {SysFont|null} null when none loads
 */
function open(paths, log) {
  const fonts = [];
  (Array.isArray(paths) ? paths : [paths]).forEach((p) => {
    if (typeof p !== "string" || !p) return;
    try {
      if (!fs.existsSync(p)) return;
      const f = lib().parse(faceBuffer(fs.readFileSync(p)), {
        lowMemory: true,
      });
      fonts.push({ path: p, font: f });
      if (log)
        log.info(
          "font " +
            p +
            ": " +
            ((f.names.fullName &&
              (f.names.fullName.en || Object.values(f.names.fullName)[0])) ||
              "?") +
            ", " +
            f.numGlyphs +
            " glyphs",
        );
    } catch (e) {
      if (log)
        log.info("font " + p + " not usable: " + ((e && e.message) || e));
    }
  });
  return fonts.length ? new SysFont(fonts) : null;
}

class SysFont {
  /** @param {FontFile[]} fonts the fallback chain, first wins */
  constructor(fonts) {
    this.fonts = fonts;
    /** @type {Map<string, GlyphHit>} */
    this.cache = new Map();
  }

  /**
   * The font and glyph for one character: the first font that has it, else the first font's .notdef.
   * @param {string} ch
   * @returns {GlyphHit}
   */
  _glyph(ch) {
    let hit = this.cache.get(ch);
    if (hit) return hit;
    for (const f of this.fonts) {
      const i = f.font.charToGlyphIndex(ch);
      if (i > 0) {
        hit = { font: f.font, glyph: f.font.glyphs.get(i) };
        break;
      }
    }
    if (!hit) {
      const f = this.fonts[0].font;
      hit = { font: f, glyph: /\s/.test(ch) ? f.charToGlyph(" ") : null };
    }
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(ch, hit);
    return hit;
  }

  /**
   * @param {GlyphHit} g
   * @param {number} size px
   * @returns {number} px
   */
  _advance(g, size) {
    return g.glyph
      ? (g.glyph.advanceWidth * size) / g.font.unitsPerEm
      : size * 0.5;
  }

  /**
   * Characters laid out at `size` px: [{ g, x }], total width. Control characters are dropped.
   * @param {string} text
   * @param {number} size px
   * @returns {{ items: Array<{ g: GlyphHit, x: number }>, width: number }}
   */
  _layout(text, size) {
    const out = [];
    let x = 0;
    for (const ch of String(text).replace(/[\u0000-\u001f\u007f]/g, " ")) {
      const g = this._glyph(ch);
      out.push({ g, x });
      x += this._advance(g, size);
    }
    return { items: out, width: x };
  }

  /**
   * @param {string} text
   * @param {number} size px
   * @returns {number} width, px
   */
  measure(text, size) {
    return this._layout(text, size).width;
  }

  /** Coverage of `text` in a boxW x boxH box: size px, baseline px from the top (0.8 x size), align left|center|right;
   *  cut with "…" to fit.
   * @param {number} boxW
   * @param {number} boxH
   * @param {string} text
   * @param {MaskOpts} opts
   * @returns {Buffer} boxW*boxH coverage bytes
   */
  mask(boxW, boxH, text, opts) {
    const size = opts.size || boxH * 0.75,
      base = opts.baseline || Math.round(size * 0.8);
    let s = String(text || "").trim(),
      lay = this._layout(s, size);
    if (lay.width > boxW && s) {
      const ell = this._advance(this._glyph("…"), size);
      let chars = Array.from(s);
      while (
        chars.length &&
        this._layout(chars.join(""), size).width + ell > boxW
      )
        chars.pop();
      s = chars.join("").replace(/\s+$/, "") + "…";
      lay = this._layout(s, size);
    }
    const x0 =
      opts.align === "right"
        ? boxW - lay.width
        : opts.align === "center"
          ? (boxW - lay.width) / 2
          : 0;
    const r = new Raster(boxW, boxH);
    lay.items.forEach((it) => {
      if (it.g.glyph)
        r.path(it.g.glyph.getPath(x0 + it.x, base, size).commands);
    });
    return r.coverage();
  }
}

/** Exact-area coverage accumulation (font-rs): lines add signed area, a running sum per row gives coverage. */
class Raster {
  /**
   * @param {number} w
   * @param {number} h
   */
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.stride = w + 2;
    this.a = new Float32Array(this.stride * h + 2);
  }

  /**
   * Adds one edge.
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   */
  line(x0, y0, x1, y1) {
    if (y0 === y1) return;
    let dir = 1;
    if (y0 > y1) {
      dir = -1;
      let t = x0;
      x0 = x1;
      x1 = t;
      t = y0;
      y0 = y1;
      y1 = t;
    }
    const dxdy = (x1 - x0) / (y1 - y0),
      W = this.w;
    const ya0 = Math.max(0, Math.floor(y0)),
      yb = Math.min(this.h, Math.ceil(y1));
    for (let y = ya0; y < yb; y++) {
      const ta = Math.max(y, y0),
        tb = Math.min(y + 1, y1);
      if (tb <= ta) continue;
      const d = (tb - ta) * dir;
      // left of the box counts at its edge (the cover is the same); right of it is dropped by the clamp
      const xa = Math.min(W, Math.max(0, x0 + (ta - y0) * dxdy)),
        xb = Math.min(W, Math.max(0, x0 + (tb - y0) * dxdy));
      const row = y * this.stride,
        a = this.a;
      const l = Math.min(xa, xb),
        r = Math.max(xa, xb);
      const li = Math.floor(l),
        ri = Math.ceil(r);
      if (ri <= li + 1) {
        const xm = 0.5 * (xa + xb) - li;
        a[row + li] += d - d * xm;
        a[row + li + 1] += d * xm;
      } else {
        const s = 1 / (r - l),
          lf = l - li,
          a0 = 0.5 * s * (1 - lf) * (1 - lf);
        const rf = r - ri + 1,
          am = 0.5 * s * rf * rf;
        a[row + li] += d * a0;
        if (ri === li + 2) a[row + li + 1] += d * (1 - a0 - am);
        else {
          const a1 = s * (1.5 - lf);
          a[row + li + 1] += d * (a1 - a0);
          for (let xi = li + 2; xi < ri - 1; xi++) a[row + xi] += d * s;
          const a2 = a1 + (ri - li - 3) * s;
          a[row + ri - 1] += d * (1 - a2 - am);
        }
        a[row + ri] += d * am;
      }
    }
  }

  /**
   * Fills an opentype.js path (M, L, Q, C, Z commands).
   * @param {Array<{ type: string, x?: number, y?: number, x1?: number, y1?: number, x2?: number, y2?: number }>} cmds
   */
  path(cmds) {
    let sx = 0,
      sy = 0,
      px = 0,
      py = 0;
    const to = (x, y) => {
      this.line(px, py, x, y);
      px = x;
      py = y;
    };
    for (const c of cmds) {
      if (c.type === "M") {
        if (px !== sx || py !== sy) this.line(px, py, sx, sy);
        sx = px = c.x;
        sy = py = c.y;
      } else if (c.type === "L") to(c.x, c.y);
      else if (c.type === "Q") {
        const n = Math.max(
            2,
            Math.min(16, Math.ceil(Math.hypot(c.x - px, c.y - py) / 3)),
          ),
          x0 = px,
          y0 = py;
        for (let i = 1; i <= n; i++) {
          const t = i / n,
            u = 1 - t;
          to(
            u * u * x0 + 2 * u * t * c.x1 + t * t * c.x,
            u * u * y0 + 2 * u * t * c.y1 + t * t * c.y,
          );
        }
      } else if (c.type === "C") {
        const n = Math.max(
            3,
            Math.min(20, Math.ceil(Math.hypot(c.x - px, c.y - py) / 3)),
          ),
          x0 = px,
          y0 = py;
        for (let i = 1; i <= n; i++) {
          const t = i / n,
            u = 1 - t;
          to(
            u * u * u * x0 +
              3 * u * u * t * c.x1 +
              3 * u * t * t * c.x2 +
              t * t * t * c.x,
            u * u * u * y0 +
              3 * u * u * t * c.y1 +
              3 * u * t * t * c.y2 +
              t * t * t * c.y,
          );
        }
      } else if (c.type === "Z") {
        to(sx, sy);
      }
    }
    if (px !== sx || py !== sy) this.line(px, py, sx, sy);
  }

  /** @returns {Buffer} w*h coverage bytes */
  coverage() {
    const out = Buffer.alloc(this.w * this.h);
    for (let y = 0; y < this.h; y++) {
      let acc = 0;
      const row = y * this.stride;
      for (let x = 0; x < this.w; x++) {
        acc += this.a[row + x];
        out[y * this.w + x] = Math.min(255, Math.round(Math.abs(acc) * 255));
      }
    }
    return out;
  }
}

// one character per script a song title is likely to use: Latin, accented Latin, Greek, Cyrillic, Hebrew, Arabic,
// Thai, Devanagari, kana, Han, Hangul
const PROBES = [
  "A",
  "é",
  "Ω",
  "Я",
  "א",
  "ع",
  "ก",
  "क",
  "あ",
  "ア",
  "中",
  "語",
  "한",
  "글",
];

/**
 * The car's own fonts, for when their paths are not known: font files under `roots` (a bounded walk: depth 6, 4000
 * entries; LastResort-style fallback fonts, emoji and styled weights left out), then picked by coverage: the font
 * with the most of PROBES first, then whichever adds the most of the rest, up to `max` fonts and `maxBytes` read.
 * Returns { all: [{ path, size }], fonts: SysFont | null, chosen: [paths] }.
 * @param {string[]} roots
 * @param {number} [max] fonts, default 4
 * @param {number} [maxBytes] default 120e6
 * @param {import("./shift_score").Log} [log]
 * @returns {{ all: Array<{ path: string, size: number }>, chosen: string[], fonts: SysFont|null }}
 */
function find(roots, max, maxBytes, log) {
  const found = [],
    seen = new Set();
  let budget = 4000;
  const walk = (dir, depth) => {
    if (depth > 6 || budget <= 0 || seen.has(dir)) return;
    seen.add(dir);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      return;
    }
    for (const n of names) {
      if (--budget <= 0) return;
      const p = dir.replace(/\/$/, "") + "/" + n;
      let st;
      try {
        st = fs.statSync(p);
      } catch (e) {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(ttf|otf|ttc|otc)$/i.test(n))
        found.push({
          path: p,
          size: st.size,
          skip: /lastresort|emoji|symbol|bold|italic|oblique|light|thin|black|heavy/i.test(
            n,
          ),
        });
    }
  };
  (roots || []).forEach((r) => walk(r, 0));
  // read the candidates (largest first: the wide-coverage ones), within the byte budget
  const cands = [];
  let bytes = 0;
  found
    .filter((f) => !f.skip && f.size < 40e6)
    .sort((a, b) => b.size - a.size)
    .forEach((f) => {
      if (cands.length >= 40 || bytes + f.size > (maxBytes || 120e6)) return;
      try {
        const font = lib().parse(faceBuffer(fs.readFileSync(f.path)), {
          lowMemory: true,
        });
        const has = PROBES.filter((ch) => font.charToGlyphIndex(ch) > 0);
        if (has.length) {
          cands.push({ path: f.path, font, has, size: f.size });
          bytes += f.size;
        }
      } catch (e) {
        /* not a font opentype.js reads */
      }
    });
  const chosen = [],
    covered = new Set();
  while (chosen.length < (max || 4)) {
    let best = null,
      gain = 0;
    cands.forEach((c) => {
      if (chosen.indexOf(c) >= 0) return;
      const g = c.has.filter((ch) => !covered.has(ch)).length;
      if (g > gain || (g === gain && g > 0 && c.size < best.size)) {
        best = c;
        gain = g;
      }
    });
    if (!best) break;
    chosen.push(best);
    best.has.forEach((ch) => covered.add(ch));
  }
  if (log)
    chosen.forEach((c) =>
      log.info("font " + c.path + " covers " + c.has.join("")),
    );
  return {
    all: found.map((f) => ({ path: f.path, size: f.size })),
    chosen: chosen.map((c) => c.path),
    fonts: chosen.length
      ? new SysFont(chosen.map((c) => ({ path: c.path, font: c.font })))
      : null,
  };
}

module.exports = { open, find, SysFont };
