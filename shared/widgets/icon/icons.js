"use strict";
/**
 * Small line icons, drawn here (no image files): straight RGBA for an image layer, w x h, in one colour.
 * Each icon is a distance function in a 0..1 box; coverage is anti-aliased over one pixel.
 *   gauge (engine), shock (chassis), wheel (steering), cog (gearbox), stack (the gear's shift program
 *   lines), therm (coolant), oilcan (oil), fuel (pump), tyre (a wheel seen from the side: ring, hub, tread notches).
 */
/**
 * Distance from (px, py) to the segment a..b.
 * @param {number} px
 * @param {number} py
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
function seg(px, py, ax, ay, bx, by) {
  const pax = px - ax,
    pay = py - ay,
    bax = bx - ax,
    bay = by - ay;
  const along = Math.max(
    0,
    Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)),
  );
  return Math.hypot(pax - bax * along, pay - bay * along);
}
/** @type {(px: number, py: number, cx: number, cy: number, radius: number) => number} distance to a circle line */
const ring = (px, py, cx, cy, radius) =>
  Math.abs(Math.hypot(px - cx, py - cy) - radius);
/** @type {(px: number, py: number, cx: number, cy: number, radius: number) => number} signed distance to a filled circle */
const disc = (px, py, cx, cy, radius) => Math.hypot(px - cx, py - cy) - radius;
/**
 * Distance to an arc of `radius` around (cx, cy), from startAngle to endAngle.
 * @param {number} px
 * @param {number} py
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @param {number} startAngle
 * @param {number} endAngle
 * @returns {number}
 */
function arc(px, py, cx, cy, radius, startAngle, endAngle) {
  // clockwise from 12 o'clock, radians, startAngle < endAngle
  let angle = Math.atan2(px - cx, -(py - cy));
  if (angle < startAngle) angle += Math.PI * 2;
  if (angle <= endAngle) return Math.abs(Math.hypot(px - cx, py - cy) - radius);
  /** @type {(theta: number) => number} */
  const endDist = (theta) =>
    Math.hypot(
      px - (cx + radius * Math.sin(theta)),
      py - (cy - radius * Math.cos(theta)),
    );
  return Math.min(endDist(startAngle), endDist(endAngle));
}

/**
 * Distance (in box units) from (x, y) to the icon's ink; < 0 or < stroke half-width = ink.
 * @typedef {(x: number, y: number) => number} IconFn
 * @type {Record<string, IconFn>}
 */
const ICONS = {
  gauge: (x, y) =>
    Math.min(
      arc(x, y, 0.5, 0.55, 0.36, -0.75 * Math.PI, 0.75 * Math.PI) - 0.045,
      seg(x, y, 0.5, 0.55, 0.7, 0.36) - 0.045,
      disc(x, y, 0.5, 0.55, 0.07),
    ),
  shock: (x, y) =>
    Math.min(
      seg(x, y, 0.24, 0.78, 0.5, 0.52) - 0.11,
      seg(x, y, 0.5, 0.52, 0.78, 0.24) - 0.035,
      seg(x, y, 0.14, 0.88, 0.2, 0.82) - 0.05,
      seg(x, y, 0.8, 0.22, 0.86, 0.16) - 0.05,
    ),
  wheel: (x, y) =>
    Math.min(
      ring(x, y, 0.5, 0.5, 0.38) - 0.055,
      disc(x, y, 0.5, 0.55, 0.1),
      seg(x, y, 0.14, 0.5, 0.42, 0.55) - 0.05,
      seg(x, y, 0.58, 0.55, 0.86, 0.5) - 0.05,
      seg(x, y, 0.5, 0.62, 0.5, 0.86) - 0.05,
    ),
  cog: (x, y) => {
    let dist = Math.min(
      ring(x, y, 0.5, 0.5, 0.27) - 0.06,
      ring(x, y, 0.5, 0.5, 0.1) - 0.04,
    );
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      dist = Math.min(
        dist,
        seg(
          x,
          y,
          0.5 + 0.3 * Math.sin(angle),
          0.5 - 0.3 * Math.cos(angle),
          0.5 + 0.42 * Math.sin(angle),
          0.5 - 0.42 * Math.cos(angle),
        ) - 0.06,
      );
    }
    return dist;
  },
  stack: (x, y) =>
    Math.min(
      seg(x, y, 0.1, 0.22, 0.62, 0.22) - 0.055,
      seg(x, y, 0.1, 0.5, 0.78, 0.5) - 0.06,
      seg(x, y, 0.1, 0.8, 0.92, 0.8) - 0.075,
    ),
  therm: (x, y) =>
    Math.min(
      seg(x, y, 0.42, 0.14, 0.42, 0.6) - 0.07,
      disc(x, y, 0.42, 0.74, 0.14),
      seg(x, y, 0.6, 0.24, 0.76, 0.24) - 0.035,
      seg(x, y, 0.6, 0.4, 0.76, 0.4) - 0.035,
    ),
  fuel: (x, y) =>
    Math.min(
      Math.max(
        Math.abs(x - 0.38) - 0.18,
        Math.abs(y - 0.55) - 0.33,
        -Math.max(Math.abs(x - 0.38) - 0.1, Math.abs(y - 0.36) - 0.08),
      ),
      seg(x, y, 0.12, 0.9, 0.64, 0.9) - 0.04,
      seg(x, y, 0.56, 0.36, 0.76, 0.48) - 0.04,
      seg(x, y, 0.76, 0.48, 0.76, 0.78) - 0.04,
      seg(x, y, 0.76, 0.78, 0.66, 0.84) - 0.04,
    ),
  tyre: (x, y) => {
    let dist = Math.min(
      ring(x, y, 0.5, 0.5, 0.4) - 0.075,
      ring(x, y, 0.5, 0.5, 0.17) - 0.04,
    );
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4 + Math.PI / 8;
      dist = Math.min(
        dist,
        seg(
          x,
          y,
          0.5 + 0.42 * Math.sin(angle),
          0.5 - 0.42 * Math.cos(angle),
          0.5 + 0.49 * Math.sin(angle),
          0.5 - 0.49 * Math.cos(angle),
        ) - 0.04,
      );
    }
    return dist;
  },
  oilcan: (x, y) =>
    Math.min(
      seg(x, y, 0.2, 0.62, 0.6, 0.62) - 0.12,
      seg(x, y, 0.6, 0.58, 0.9, 0.44) - 0.04,
      disc(x, y, 0.92, 0.66, 0.05),
      seg(x, y, 0.3, 0.46, 0.3, 0.34) - 0.035,
      seg(x, y, 0.22, 0.34, 0.38, 0.34) - 0.04,
    ),
};

/**
 * Paints an icon as straight RGBA.
 * @param {string} name a key of ICONS; an unknown name gives a clear image
 * @param {number} w
 * @param {number} h
 * @param {number[]} color [r, g, b] or [r, g, b, a], 0..255
 * @returns {Buffer} w*h*4 bytes
 */
function paintIcon(name, w, h, color) {
  const iconFn = ICONS[name],
    out = Buffer.alloc(w * h * 4, 0);
  if (!iconFn) return out;
  const side = Math.min(w, h),
    offsetX = (w - side) / 2,
    offsetY = (h - side) / 2,
    pixelSize = 1 / side;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = iconFn(
        (x + 0.5 - offsetX) / side,
        (y + 0.5 - offsetY) / side,
      );
      const coverage = Math.max(0, Math.min(1, 0.5 - dist / pixelSize));
      if (coverage <= 0) continue;
      const offset = (y * w + x) * 4;
      out[offset] = color[0];
      out[offset + 1] = color[1];
      out[offset + 2] = color[2];
      out[offset + 3] = Math.round(
        coverage * (color[3] === undefined ? 255 : color[3]),
      );
    }
  }
  return out;
}

module.exports = { paintIcon, ICONS };
