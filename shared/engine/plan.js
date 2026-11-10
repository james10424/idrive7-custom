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
  /** @type {(offset: number) => boolean} */
  const samePx = (offset) =>
    now[offset] === was[offset] &&
    now[offset + 1] === was[offset + 1] &&
    now[offset + 2] === was[offset + 2] &&
    now[offset + 3] === was[offset + 3];
  let top = 0;
  while (top < h && sameRow(top)) top++;
  if (top === h) return null;
  let bottom = h - 1;
  while (sameRow(bottom)) bottom--;
  let left = w,
    right = -1;
  for (let y = top; y <= bottom; y++) {
    if (sameRow(y)) continue;
    const rowStart = y * row;
    for (let x = 0; x < left; x++)
      if (!samePx(rowStart + x * 4)) {
        left = x;
        break;
      }
    for (let x = w - 1; x > right; x--)
      if (!samePx(rowStart + x * 4)) {
        right = x;
        break;
      }
  }
  const rect = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  const pixels = Buffer.allocUnsafe(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++)
    now.copy(
      pixels,
      y * rect.w * 4,
      (top + y) * row + left * 4,
      (top + y) * row + (right + 1) * 4,
    );
  return { rect, px: pixels };
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
    /** @type {(sheet: Rect, rect: Rect) => Rect} */
    const union = (sheet, rect) => {
      const x = Math.min(sheet.x, rect.x),
        y = Math.min(sheet.y, rect.y);
      return {
        x,
        y,
        w: Math.max(sheet.x + sheet.w, rect.x + rect.w) - x,
        h: Math.max(sheet.y + sheet.h, rect.y + rect.h) - y,
      };
    };
    widgets.forEach((widget) => {
      const klass = widget.class || "content",
        layerZ = widget.z || 0,
        conn = this._connOf(widget);
      if (!isImage(widget.type) || widget.own === true) {
        plan.push({ kind: "layer", w: widget, klass, z: layerZ, conn });
        return;
      }
      let after = -1;
      plan.forEach((entry, i) => {
        if (entry.klass !== klass || entry.z !== layerZ || entry.conn !== conn)
          return;
        if (
          entry.kind === "layer"
            ? hit(entry.w, widget)
            : entry.members.some((member) => hit(member, widget))
        )
          after = i;
      });
      let sheet = null,
        box = null;
      for (let i = after + 1; i < plan.length && !sheet; i++) {
        const candidate = plan[i];
        if (
          candidate.kind !== "sheet" ||
          candidate.klass !== klass ||
          candidate.z !== layerZ ||
          candidate.conn !== conn
        )
          continue;
        const merged = union(candidate, widget);
        if (merged.w * merged.h <= maxPx) {
          sheet = candidate;
          box = merged;
        }
      }
      if (!sheet) {
        sheet = {
          kind: "sheet",
          klass,
          z: layerZ,
          conn,
          x: widget.x,
          y: widget.y,
          w: widget.w,
          h: widget.h,
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
      sheet.members.push(widget);
    });
    return plan;
  },

  /**
   * One image layer for a sheet: every member painted into a local buffer, then sent whole once.
   * @param {Sheet} sheet
   * @returns {void}
   */
  _createSheet(sheet) {
    const client = this._clientAt(sheet.conn);
    const ref = client.image({
      target: this.target,
      klass: sheet.klass,
      z: sheet.z,
      x: sheet.x,
      y: sheet.y,
      w: sheet.w,
      h: sheet.h,
      iw: sheet.w,
      ih: sheet.h,
    });
    if (!ref) {
      this.log.warn(
        "sheet " +
          sheet.klass +
          "/" +
          sheet.z +
          " at " +
          sheet.x +
          "," +
          sheet.y +
          " " +
          sheet.w +
          "x" +
          sheet.h +
          ": layer refused",
      );
      return;
    }
    sheet.ref = ref;
    sheet.c = client;
    sheet.ci = sheet.conn;
    sheet.buf = Buffer.alloc(sheet.w * sheet.h * 4, 0);
    this.sheets.push(sheet);
    sheet.members.forEach((widget) =>
      this._guard("widget " + widget.id, () => this._create(widget, sheet)),
    );
    const buf = sheet.buf;
    sheet.buf = null; // from here on _blit sends dirty rects
    client.pixels(ref, null, buf);
  },

  /**
   * Every pixel painter goes through here: the widget's pixels (rects in the widget's own px, or null for
   * the whole widget) to its own layer, or into its sheet: the local buffer while the sheet is being
   * filled on create, else dirty rects translated by the sheet's offset.
   * @param {WidgetState} state
   * @param {?Rect[]} rects
   * @param {Buffer} buf
   * @returns {void}
   */
  _blit(state, rects, buf) {
    const widget = state.w,
      sheet = state.sheet;
    if (!sheet) {
      state.c.pixels(state.ref, rects, buf);
      return;
    }
    const ownRects =
      rects && rects.length
        ? rects
        : [{ x: 0, y: 0, w: widget.w, h: widget.h }];
    const dx = widget.x - sheet.x,
      dy = widget.y - sheet.y;
    const moved = ownRects.map((rect) => ({
      x: rect.x + dx,
      y: rect.y + dy,
      w: rect.w,
      h: rect.h,
    }));
    if (!sheet.buf) {
      sheet.c.pixels(sheet.ref, moved, buf);
      return;
    }
    let off = 0;
    moved.forEach((rect) => {
      for (let y = 0; y < rect.h; y++) {
        buf.copy(
          sheet.buf,
          ((rect.y + y) * sheet.w + rect.x) * 4,
          off,
          off + rect.w * 4,
        );
        off += rect.w * 4;
      }
    });
  },

  /**
   * A whole repaint of an image widget: the first time (or while its sheet is being filled) the whole widget
   * goes up; after that only the one rectangle around the pixels that changed, or nothing at all.
   * @param {WidgetState} state
   * @param {Buffer} buf
   * @returns {void}
   */
  _blitDiff(state, buf) {
    const widget = state.w,
      was = state.px;
    state.px = buf;
    if (!was || (state.sheet && state.sheet.buf)) {
      this._blit(state, null, buf);
      return;
    }
    const change = changes(was, buf, widget.w, widget.h);
    if (change) this._blit(state, [change.rect], change.px);
  },

  /**
   * The first widget on that layer, for the logs; a sheet is named by its first member plus how many more it holds.
   * @param {number} connIndex
   * @param {number} ref
   * @returns {?string}
   */
  _widgetOf(connIndex, ref) {
    let firstId = null,
      count = 0;
    this.widgets.forEach((state) => {
      if (state.ci === connIndex && state.ref === ref) {
        if (!firstId) firstId = state.w.id;
        count++;
      }
    });
    return count > 1 ? firstId + " +" + (count - 1) : firstId;
  },

  /**
   * Every layer of the layout now (effects, sheets and own image layers), each once: { c, ci, ref, key }.
   * @returns {LayerRef[]}
   */
  _layerRefs() {
    const refs = [],
      seen = {};
    this.widgets.forEach((state) => {
      const key = state.ci + ":" + state.ref;
      if (!seen[key]) {
        seen[key] = true;
        refs.push({ c: state.c, ci: state.ci, ref: state.ref, key });
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
    this.widgets.forEach((state) => {
      seen[state.ci] = true;
    });
    return Object.keys(seen).length;
  },

  /**
   * The connection a widget asks for ("conn", 0..3; 0 the app's own).
   * @param {Widget} widget
   * @returns {number}
   */
  _connOf(widget) {
    const conn = isNum(widget.conn) ? Math.floor(widget.conn) : 0;
    return Math.max(0, Math.min(MAX_CONN - 1, conn));
  },

  /**
   * Layers per connection in a plan: [n on connection 1, n on 2, ...].
   * @param {PlanEntry[]} plan
   * @returns {number[]}
   */
  _connCounts(plan) {
    const counts = [];
    plan.forEach((entry) => {
      counts[entry.conn] = (counts[entry.conn] || 0) + 1;
    });
    for (let i = 0; i < counts.length; i++) counts[i] = counts[i] || 0;
    return counts;
  },

  /**
   * "1 layer" or "n layers".
   * @param {number} count
   * @returns {string}
   */
  _layerCount(count) {
    return count === 1 ? "1 layer" : count + " layers";
  },
});
