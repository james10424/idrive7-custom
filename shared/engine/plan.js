"use strict";
/**
 * Layer planning: image widgets packed into sheets, effect and "own" widgets on their own layers, the
 * connections they go on, and every pixel write (whole sheets on create, dirty rects after).
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const { MAX_CONN, isImage } = require("./consts");
const { isNum } = require("./util");

/** @typedef {import("./app").Widget} Widget */
/** @typedef {import("./app").WidgetState} WidgetState */
/** @typedef {import("./app").Sheet} Sheet */
/** @typedef {import("./app").PlanEntry} PlanEntry */
/** @typedef {import("./app").Rect} Rect */
/** @typedef {import("./app").LayerRef} LayerRef */

/**
 * The one rectangle around what differs between two RGBA images of the same size, with its pixels, or null
 * when they are the same (after idrive7-EVAHUD's eva_canvas.js, MIT). The link is what is short, not the CPU:
 * comparing a widget costs about a tenth of painting it.
 * @param {Buffer} was
 * @param {Buffer} now
 * @param {number} w
 * @param {number} h
 * @returns {?{ rect: Rect, px: Buffer }}
 */
function changes(was, now, w, h) {
  const row = w * 4;
  /** @type {(y: number) => boolean} */
  const sameRow = (y) =>
    now.compare(was, y * row, (y + 1) * row, y * row, (y + 1) * row) === 0;
  /** @type {(o: number) => boolean} */
  const samePx = (o) =>
    now[o] === was[o] &&
    now[o + 1] === was[o + 1] &&
    now[o + 2] === was[o + 2] &&
    now[o + 3] === was[o + 3];
  let top = 0;
  while (top < h && sameRow(top)) top++;
  if (top === h) return null;
  let bottom = h - 1;
  while (sameRow(bottom)) bottom--;
  let left = w,
    right = -1;
  for (let y = top; y <= bottom; y++) {
    if (sameRow(y)) continue;
    const o = y * row;
    for (let x = 0; x < left; x++)
      if (!samePx(o + x * 4)) {
        left = x;
        break;
      }
    for (let x = w - 1; x > right; x--)
      if (!samePx(o + x * 4)) {
        right = x;
        break;
      }
  }
  const rect = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  const px = Buffer.allocUnsafe(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++)
    now.copy(
      px,
      y * rect.w * 4,
      (top + y) * row + left * 4,
      (top + y) * row + (right + 1) * 4,
    );
  return { rect, px };
}

module.exports = /** @satisfies {ThisType<import("./app").App>} */ ({
  /**
   * The layers of a layout, in the order to make them: { kind: 'layer', w } for an effect or an "own"
   * image widget, { kind: 'sheet', klass, z, x, y, w, h, members } for a packed image layer. Widgets are
   * taken in file order; an image widget joins the first sheet of its (class, z) group that was opened
   * after every earlier entry of that group its rect intersects (so what overlaps it stays under it, as
   * file order says) and whose union box with it stays within maxPx pixels, else a new sheet is opened
   * at the end.
   * @param {Widget[]} widgets
   * @param {number} maxPx the sheet size limit
   * @returns {PlanEntry[]}
   */
  _plan(widgets, maxPx) {
    const plan = [];
    /** @type {(a: Rect, b: Rect) => boolean} */
    const hit = (a, b) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    /** @type {(s: Rect, w: Rect) => Rect} */
    const union = (s, w) => {
      const x = Math.min(s.x, w.x),
        y = Math.min(s.y, w.y);
      return {
        x,
        y,
        w: Math.max(s.x + s.w, w.x + w.w) - x,
        h: Math.max(s.y + s.h, w.y + w.h) - y,
      };
    };
    widgets.forEach((w) => {
      const klass = w.class || "content",
        z = w.z || 0,
        conn = this._connOf(w);
      if (!isImage(w.type) || w.own === true) {
        plan.push({ kind: "layer", w, klass, z, conn });
        return;
      }
      let after = -1;
      plan.forEach((e, i) => {
        if (e.klass !== klass || e.z !== z || e.conn !== conn) return;
        if (e.kind === "layer" ? hit(e.w, w) : e.members.some((m) => hit(m, w)))
          after = i;
      });
      let sheet = null,
        box = null;
      for (let i = after + 1; i < plan.length && !sheet; i++) {
        const s = plan[i];
        if (
          s.kind !== "sheet" ||
          s.klass !== klass ||
          s.z !== z ||
          s.conn !== conn
        )
          continue;
        const u = union(s, w);
        if (u.w * u.h <= maxPx) {
          sheet = s;
          box = u;
        }
      }
      if (!sheet) {
        sheet = {
          kind: "sheet",
          klass,
          z,
          conn,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          members: [],
          ref: 0,
          c: null,
          ci: conn,
          buf: null,
        };
        plan.push(sheet);
      } else {
        sheet.x = box.x;
        sheet.y = box.y;
        sheet.w = box.w;
        sheet.h = box.h;
      }
      sheet.members.push(w);
    });
    return plan;
  },

  /**
   * One image layer for a sheet: every member painted into a local buffer, then sent whole once.
   * @param {Sheet} s
   * @returns {void}
   */
  _createSheet(s) {
    const c = this._clientAt(s.conn);
    const ref = c.image({
      target: this.target,
      klass: s.klass,
      z: s.z,
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      iw: s.w,
      ih: s.h,
    });
    if (!ref) {
      this.log.warn(
        "sheet " +
          s.klass +
          "/" +
          s.z +
          " at " +
          s.x +
          "," +
          s.y +
          " " +
          s.w +
          "x" +
          s.h +
          ": layer refused",
      );
      return;
    }
    s.ref = ref;
    s.c = c;
    s.ci = s.conn;
    s.buf = Buffer.alloc(s.w * s.h * 4, 0);
    this.sheets.push(s);
    s.members.forEach((w) =>
      this._guard("widget " + w.id, () => this._create(w, s)),
    );
    const buf = s.buf;
    s.buf = null; // from here on _blit sends dirty rects
    c.pixels(ref, null, buf);
  },

  /**
   * Every pixel painter goes through here: the widget's pixels (rects in the widget's own px, or null for
   * the whole widget) to its own layer, or into its sheet: the local buffer while the sheet is being
   * filled on create, else dirty rects translated by the sheet's offset.
   * @param {WidgetState} x
   * @param {?Rect[]} rects
   * @param {Buffer} buf
   * @returns {void}
   */
  _blit(x, rects, buf) {
    const w = x.w,
      s = x.sheet;
    if (!s) {
      x.c.pixels(x.ref, rects, buf);
      return;
    }
    const rs = rects && rects.length ? rects : [{ x: 0, y: 0, w: w.w, h: w.h }];
    const dx = w.x - s.x,
      dy = w.y - s.y;
    const moved = rs.map((r) => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }));
    if (!s.buf) {
      s.c.pixels(s.ref, moved, buf);
      return;
    }
    let off = 0;
    moved.forEach((r) => {
      for (let y = 0; y < r.h; y++) {
        buf.copy(s.buf, ((r.y + y) * s.w + r.x) * 4, off, off + r.w * 4);
        off += r.w * 4;
      }
    });
  },

  /**
   * A whole repaint of an image widget: the first time (or while its sheet is being filled) the whole widget
   * goes up; after that only the one rectangle around the pixels that changed, or nothing at all.
   * @param {WidgetState} x
   * @param {Buffer} buf
   * @returns {void}
   */
  _blitDiff(x, buf) {
    const w = x.w,
      was = x.px;
    x.px = buf;
    if (!was || (x.sheet && x.sheet.buf)) {
      this._blit(x, null, buf);
      return;
    }
    const c = changes(was, buf, w.w, w.h);
    if (c) this._blit(x, [c.rect], c.px);
  },

  /**
   * The first widget on that layer, for the logs; a sheet is named by its first member plus how many more it holds.
   * @param {number} ci
   * @param {number} ref
   * @returns {?string}
   */
  _widgetOf(ci, ref) {
    let id = null,
      n = 0;
    this.widgets.forEach((x) => {
      if (x.ci === ci && x.ref === ref) {
        if (!id) id = x.w.id;
        n++;
      }
    });
    return n > 1 ? id + " +" + (n - 1) : id;
  },

  /**
   * Every layer of the layout now (effects, sheets and own image layers), each once: { c, ci, ref, key }.
   * @returns {LayerRef[]}
   */
  _layerRefs() {
    const refs = [],
      seen = {};
    this.widgets.forEach((x) => {
      const key = x.ci + ":" + x.ref;
      if (!seen[key]) {
        seen[key] = true;
        refs.push({ c: x.c, ci: x.ci, ref: x.ref, key });
      }
    });
    return refs;
  },

  /**
   * How many connections the layout now uses.
   * @returns {number}
   */
  _connCount() {
    const seen = {};
    this.widgets.forEach((x) => {
      seen[x.ci] = true;
    });
    return Object.keys(seen).length;
  },

  /**
   * The connection a widget asks for ("conn", 0..3; 0 the app's own).
   * @param {Widget} w
   * @returns {number}
   */
  _connOf(w) {
    const n = isNum(w.conn) ? Math.floor(w.conn) : 0;
    return Math.max(0, Math.min(MAX_CONN - 1, n));
  },

  /**
   * Layers per connection in a plan: [n on connection 1, n on 2, ...].
   * @param {PlanEntry[]} plan
   * @returns {number[]}
   */
  _connCounts(plan) {
    const counts = [];
    plan.forEach((e) => {
      counts[e.conn] = (counts[e.conn] || 0) + 1;
    });
    for (let i = 0; i < counts.length; i++) counts[i] = counts[i] || 0;
    return counts;
  },

  /**
   * "1 layer" or "n layers".
   * @param {number} n
   * @returns {string}
   */
  _layerCount(n) {
    return n === 1 ? "1 layer" : n + " layers";
  },
});
