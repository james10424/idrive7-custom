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
  const wholeFile = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.length,
  );
  if (buf.toString("latin1", 0, 4) !== "ttcf") return wholeFile;
  // table offsets in a collection are from the file's start, so keep the file whole and copy the first face's
  // directory over the collection header (the header and the face directories come before any table data)
  const dirOffset = buf.readUInt32BE(12),
    numTables = buf.readUInt16BE(dirOffset + 4),
    dirLength = 12 + 16 * numTables;
  const out = Buffer.from(buf);
  buf.copy(out, 0, dirOffset, dirOffset + dirLength);
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
  (Array.isArray(paths) ? paths : [paths]).forEach((fontPath) => {
    if (typeof fontPath !== "string" || !fontPath) return;
    try {
      if (!fs.existsSync(fontPath)) return;
      const font = lib().parse(faceBuffer(fs.readFileSync(fontPath)), {
        lowMemory: true,
      });
      fonts.push({ path: fontPath, font: font });
      if (log)
        log.info(
          "font " +
            fontPath +
            ": " +
            ((font.names.fullName &&
              (font.names.fullName.en ||
                Object.values(font.names.fullName)[0])) ||
              "?") +
            ", " +
            font.numGlyphs +
            " glyphs",
        );
    } catch (err) {
      if (log)
        log.info(
          "font " + fontPath + " not usable: " + ((err && err.message) || err),
        );
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
   * @param {string} char
   * @returns {GlyphHit}
   */
  _glyph(char) {
    let hit = this.cache.get(char);
    if (hit) return hit;
    for (const file of this.fonts) {
      const i = file.font.charToGlyphIndex(char);
      if (i > 0) {
        hit = { font: file.font, glyph: file.font.glyphs.get(i) };
        break;
      }
    }
    if (!hit) {
      const font = this.fonts[0].font;
      hit = {
        font: font,
        glyph: /\s/.test(char) ? font.charToGlyph(" ") : null,
      };
    }
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(char, hit);
    return hit;
  }

  /**
   * @param {GlyphHit} hit
   * @param {number} size px
   * @returns {number} px
   */
  _advance(hit, size) {
    return hit.glyph
      ? (hit.glyph.advanceWidth * size) / hit.font.unitsPerEm
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
    for (const char of String(text).replace(/[\u0000-\u001f\u007f]/g, " ")) {
      const hit = this._glyph(char);
      out.push({ g: hit, x });
      x += this._advance(hit, size);
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
    let shown = String(text || "").trim(),
      layout = this._layout(shown, size);
    if (layout.width > boxW && shown) {
      const ellipsisWidth = this._advance(this._glyph("…"), size);
      let chars = Array.from(shown);
      while (
        chars.length &&
        this._layout(chars.join(""), size).width + ellipsisWidth > boxW
      )
        chars.pop();
      shown = chars.join("").replace(/\s+$/, "") + "…";
      layout = this._layout(shown, size);
    }
    const x0 =
      opts.align === "right"
        ? boxW - layout.width
        : opts.align === "center"
          ? (boxW - layout.width) / 2
          : 0;
    const raster = new Raster(boxW, boxH);
    layout.items.forEach((item) => {
      if (item.g.glyph)
        raster.path(item.g.glyph.getPath(x0 + item.x, base, size).commands);
    });
    return raster.coverage();
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
      let swap = x0;
      x0 = x1;
      x1 = swap;
      swap = y0;
      y0 = y1;
      y1 = swap;
    }
    const dxdy = (x1 - x0) / (y1 - y0),
      width = this.w;
    const rowStart = Math.max(0, Math.floor(y0)),
      rowEnd = Math.min(this.h, Math.ceil(y1));
    for (let y = rowStart; y < rowEnd; y++) {
      const spanTop = Math.max(y, y0),
        spanBottom = Math.min(y + 1, y1);
      if (spanBottom <= spanTop) continue;
      const cover = (spanBottom - spanTop) * dir;
      // left of the box counts at its edge (the cover is the same); right of it is dropped by the clamp
      const xTop = Math.min(width, Math.max(0, x0 + (spanTop - y0) * dxdy)),
        xBottom = Math.min(width, Math.max(0, x0 + (spanBottom - y0) * dxdy));
      const row = y * this.stride,
        accum = this.a;
      const left = Math.min(xTop, xBottom),
        right = Math.max(xTop, xBottom);
      const leftCell = Math.floor(left),
        rightCell = Math.ceil(right);
      if (rightCell <= leftCell + 1) {
        const xMid = 0.5 * (xTop + xBottom) - leftCell;
        accum[row + leftCell] += cover - cover * xMid;
        accum[row + leftCell + 1] += cover * xMid;
      } else {
        const invWidth = 1 / (right - left),
          leftFrac = left - leftCell,
          leftArea = 0.5 * invWidth * (1 - leftFrac) * (1 - leftFrac);
        const rightFrac = right - rightCell + 1,
          rightArea = 0.5 * invWidth * rightFrac * rightFrac;
        accum[row + leftCell] += cover * leftArea;
        if (rightCell === leftCell + 2)
          accum[row + leftCell + 1] += cover * (1 - leftArea - rightArea);
        else {
          const cumSecond = invWidth * (1.5 - leftFrac);
          accum[row + leftCell + 1] += cover * (cumSecond - leftArea);
          for (let cell = leftCell + 2; cell < rightCell - 1; cell++)
            accum[row + cell] += cover * invWidth;
          const cumBeforeRight =
            cumSecond + (rightCell - leftCell - 3) * invWidth;
          accum[row + rightCell - 1] +=
            cover * (1 - cumBeforeRight - rightArea);
        }
        accum[row + rightCell] += cover * rightArea;
      }
    }
  }

  /**
   * Fills an opentype.js path (M, L, Q, C, Z commands).
   * @param {Array<{ type: string, x?: number, y?: number, x1?: number, y1?: number, x2?: number, y2?: number }>} cmds
   */
  path(cmds) {
    let startX = 0,
      startY = 0,
      penX = 0,
      penY = 0;
    const lineTo = (x, y) => {
      this.line(penX, penY, x, y);
      penX = x;
      penY = y;
    };
    for (const cmd of cmds) {
      if (cmd.type === "M") {
        if (penX !== startX || penY !== startY)
          this.line(penX, penY, startX, startY);
        startX = penX = cmd.x;
        startY = penY = cmd.y;
      } else if (cmd.type === "L") lineTo(cmd.x, cmd.y);
      else if (cmd.type === "Q") {
        const steps = Math.max(
            2,
            Math.min(16, Math.ceil(Math.hypot(cmd.x - penX, cmd.y - penY) / 3)),
          ),
          x0 = penX,
          y0 = penY;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps,
            u = 1 - t;
          lineTo(
            u * u * x0 + 2 * u * t * cmd.x1 + t * t * cmd.x,
            u * u * y0 + 2 * u * t * cmd.y1 + t * t * cmd.y,
          );
        }
      } else if (cmd.type === "C") {
        const steps = Math.max(
            3,
            Math.min(20, Math.ceil(Math.hypot(cmd.x - penX, cmd.y - penY) / 3)),
          ),
          x0 = penX,
          y0 = penY;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps,
            u = 1 - t;
          lineTo(
            u * u * u * x0 +
              3 * u * u * t * cmd.x1 +
              3 * u * t * t * cmd.x2 +
              t * t * t * cmd.x,
            u * u * u * y0 +
              3 * u * u * t * cmd.y1 +
              3 * u * t * t * cmd.y2 +
              t * t * t * cmd.y,
          );
        }
      } else if (cmd.type === "Z") {
        lineTo(startX, startY);
      }
    }
    if (penX !== startX || penY !== startY)
      this.line(penX, penY, startX, startY);
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
    } catch (err) {
      return;
    }
    for (const name of names) {
      if (--budget <= 0) return;
      const filePath = dir.replace(/\/$/, "") + "/" + name;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (err) {
        continue;
      }
      if (stat.isDirectory()) walk(filePath, depth + 1);
      else if (/\.(ttf|otf|ttc|otc)$/i.test(name))
        found.push({
          path: filePath,
          size: stat.size,
          skip: /lastresort|emoji|symbol|bold|italic|oblique|light|thin|black|heavy/i.test(
            name,
          ),
        });
    }
  };
  (roots || []).forEach((root) => walk(root, 0));
  // read the candidates (largest first: the wide-coverage ones), within the byte budget
  const candidates = [];
  let bytes = 0;
  found
    .filter((file) => !file.skip && file.size < 40e6)
    .sort((a, b) => b.size - a.size)
    .forEach((file) => {
      if (candidates.length >= 40 || bytes + file.size > (maxBytes || 120e6))
        return;
      try {
        const font = lib().parse(faceBuffer(fs.readFileSync(file.path)), {
          lowMemory: true,
        });
        const has = PROBES.filter((char) => font.charToGlyphIndex(char) > 0);
        if (has.length) {
          candidates.push({ path: file.path, font, has, size: file.size });
          bytes += file.size;
        }
      } catch (err) {
        /* not a font opentype.js reads */
      }
    });
  const chosen = [],
    covered = new Set();
  while (chosen.length < (max || 4)) {
    let best = null,
      gain = 0;
    candidates.forEach((candidate) => {
      if (chosen.indexOf(candidate) >= 0) return;
      const newChars = candidate.has.filter(
        (char) => !covered.has(char),
      ).length;
      if (
        newChars > gain ||
        (newChars === gain && newChars > 0 && candidate.size < best.size)
      ) {
        best = candidate;
        gain = newChars;
      }
    });
    if (!best) break;
    chosen.push(best);
    best.has.forEach((char) => covered.add(char));
  }
  if (log)
    chosen.forEach((candidate) =>
      log.info("font " + candidate.path + " covers " + candidate.has.join("")),
    );
  return {
    all: found.map((file) => ({ path: file.path, size: file.size })),
    chosen: chosen.map((candidate) => candidate.path),
    fonts: chosen.length
      ? new SysFont(
          chosen.map((candidate) => ({
            path: candidate.path,
            font: candidate.font,
          })),
        )
      : null,
  };
}

module.exports = { open, find, SysFont };
