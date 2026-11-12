"use strict";
/**
 * HUD colour themes. Layouts name colour *roles* ("fg", "dim", "arc", ...) and
 * the active theme fills them in, so every layout works in every theme.
 *
 * Colours are [r, g, b, a] 0-255. On the HUD, black is see-through glass, so a
 * theme only ever adds light. Dark blue is the weakest colour on a HUD in sun;
 * M's mid blue is kept brighter than the paint-chip M blue for that reason.
 *
 * bar: the shift bar's three zones. lowColor up to midAt, midColor up to the
 * red zone, highColor from there. midAt: 'shift' = where the shift zone starts
 * (redline - 1500), or a fraction of the bar (M climbs light blue -> blue at 50%).
 */
/** @typedef {number[]} Rgba [r, g, b, a] 0..255 (a may be left out: opaque) */
/**
 * A colour theme: roles a layout names, filled in.
 * @typedef {object} Theme
 * @property {string} name shown in the settings
 * @property {Rgba} fg
 * @property {Rgba} dim
 * @property {Rgba} track
 * @property {Rgba} arc
 * @property {Rgba} [hot] the shift-point red (added to every theme below)
 * @property {number} glow 0..1
 * @property {boolean} stripe draws the M stripe
 * @property {{ low: Rgba, mid: Rgba, high: Rgba, midAt: "shift"|number }} bar the shift bar's zones
 * @property {{ from: Rgba, to: Rgba }} rev the rev bar ramp
 */

/** @type {Record<string, Theme>} */
const THEMES = {
  classic: {
    name: "Classic",
    fg: [243, 246, 250, 255],
    dim: [243, 246, 250, 148],
    track: [243, 246, 250, 36],
    arc: [243, 246, 250, 255],
    glow: 0.35,
    stripe: false,
    bar: {
      low: [243, 246, 250],
      mid: [255, 154, 60],
      high: [255, 75, 62],
      midAt: "shift",
    },
    rev: { from: [120, 128, 140], to: [243, 246, 250] },
  },
  m: {
    name: "M",
    fg: [243, 246, 250, 255],
    dim: [170, 205, 255, 158],
    track: [80, 150, 255, 41],
    arc: [79, 180, 255, 255],
    glow: 0.4,
    stripe: true,
    bar: {
      low: [79, 180, 255],
      mid: [51, 102, 255],
      high: [232, 38, 45],
      midAt: 0.5,
    },
    rev: { from: [51, 102, 255], to: [110, 170, 255] },
  },
  night: {
    name: "Night",
    fg: [255, 179, 71, 255],
    dim: [255, 179, 71, 140],
    track: [255, 179, 71, 36],
    arc: [255, 179, 71, 255],
    glow: 0.3,
    stripe: false,
    bar: {
      low: [255, 179, 71],
      mid: [255, 179, 71],
      high: [255, 75, 62],
      midAt: "shift",
    },
    rev: { from: [150, 95, 35], to: [255, 179, 71] },
  },
  // Cluster theme (a layout's own "theme"). The cluster is an LCD, not glass: black is solid black there,
  // and it covers BMW's gauges under it. Extra roles: bg (the screen), panel (box inside), line (box
  // frame), head (box header strip), ink (text on a header), accent (a highlighted header).
  // The car brightens dark tints (Nov 5 2026: a navy backdrop came out light steel blue), so until that curve
  // is measured every large area (bg, panel, well) is pure black in all the cluster themes.
  gt3: {
    name: "GT3",
    fg: [244, 244, 244, 255],
    dim: [150, 154, 160, 255],
    track: [255, 255, 255, 26],
    arc: [244, 244, 244, 255],
    glow: 0,
    stripe: false,
    bar: {
      low: [57, 222, 72],
      mid: [255, 196, 0],
      high: [255, 42, 42],
      midAt: "shift",
    },
    rev: { from: [57, 222, 72], to: [57, 222, 72] },
    bg: [0, 0, 0, 255],
    panel: [0, 0, 0, 255],
    line: [205, 208, 214, 255],
    head: [226, 228, 232, 255],
    ink: [12, 12, 14, 255],
    accent: [255, 196, 0, 255],
    well: [0, 0, 0, 255],
    wellLine: [70, 74, 80, 255],
  },
  // Sport (layout sport.json): BMW's Live Cockpit Sport view, blue speed and red revs round the map.
  // Extra roles: sblue / spink (the speed and rpm scale numbers), sred (the rpm caption).
  sportdash: {
    name: "Sport",
    fg: [244, 247, 252, 255],
    dim: [150, 170, 205, 255],
    track: [70, 80, 100, 255],
    arc: [60, 215, 255, 255],
    glow: 0,
    stripe: false,
    bar: {
      low: [60, 215, 255],
      mid: [60, 215, 255],
      high: [255, 42, 42],
      midAt: "shift",
    },
    rev: { from: [224, 26, 56], to: [224, 26, 56] },
    bg: [0, 0, 0, 255],
    panel: [0, 0, 0, 255],
    line: [60, 215, 255, 255],
    head: [226, 228, 232, 255],
    ink: [12, 12, 14, 255],
    accent: [60, 215, 255, 255],
    well: [0, 0, 0, 255],
    faint: [96, 110, 135, 255],
    sblue: [120, 170, 245, 255],
    spink: [236, 140, 140, 255],
    sred: [235, 60, 70, 255],
    sgreen: [47, 210, 122, 255],
    syellow: [255, 194, 26, 255],
  },
  // Grand National (layout regal.json, after a 1987 Buick Grand National's dash): white numbers, the orange VFD, green lamps. Extra roles:
  // vfd (the VFD's orange), kmh (the km/h row), lampText (on the lit BRAKE lamp), green (turn and cruise lamps), gearText (the P R N D S row, see-through).
  regal: {
    name: "Grand National",
    fg: [240, 240, 240, 255],
    dim: [170, 172, 178, 255],
    track: [80, 80, 84, 255],
    arc: [255, 96, 24, 255],
    glow: 0,
    stripe: false,
    bar: {
      low: [255, 96, 24],
      mid: [255, 96, 24],
      high: [255, 42, 42],
      midAt: "shift",
    },
    rev: { from: [255, 96, 24], to: [255, 96, 24] },
    bg: [0, 0, 0, 255],
    panel: [0, 0, 0, 255],
    line: [160, 164, 172, 255],
    head: [226, 228, 232, 255],
    ink: [12, 12, 14, 255],
    accent: [255, 96, 24, 255],
    well: [0, 0, 0, 255],
    vfd: [255, 92, 22, 255],
    kmh: [222, 112, 52, 255],
    lampText: [255, 222, 200, 255],
    lampTextG: [225, 255, 230, 255],
    green: [60, 235, 100, 255],
    amber: [255, 160, 40, 255],
    gearText: [240, 240, 240, 165], // P R N D S: white, see-through so the red needle under them shows
  },
};
// every theme: the shift-point red, used by "hot" (the gear and SHIFT at the shift point, the rev bar past it)
Object.keys(THEMES).forEach((k) => {
  THEMES[k].hot = [255, 42, 42, 255];
});

// Redline layout (after cauliflowermossgrape's Redline app): rev bar segments ramp rev.from -> rev.to up to
// the shift point; the shift lights run green -> yellow -> red in every theme; grade badges by verdict.
/** @type {Record<string, Rgba>} */
const LIGHTS = {
  green: [47, 210, 122],
  yellow: [255, 194, 26],
  red: [255, 42, 42],
  blue: [40, 110, 255],
};
/** @type {Record<string, Rgba>} */
const VERDICT = {
  "SPOT ON": [47, 210, 122, 255],
  EARLY: [255, 194, 26, 255],
  LATE: [255, 138, 26, 255],
  LIMITER: [255, 42, 42, 255],
  "COLD REV": [61, 139, 255, 255],
  COLD: [61, 139, 255, 255],
};

// The M tricolour stripe: light blue, dark blue, red (brightened for the HUD).
/** @type {Rgba[]} */
const M_STRIPE = [
  [79, 180, 255, 255],
  [47, 91, 216, 255],
  [232, 38, 45, 255],
];

/**
 * A colour from a role name ("fg") or a literal [r,g,b,a].
 * @param {Theme} theme
 * @param {string|Rgba} spec
 * @returns {Rgba}
 */
function color(theme, spec) {
  if (Array.isArray(spec)) return spec;
  return /** @type {Record<string, Rgba | undefined>} */ (/** @type {unknown} */ (theme))[spec] || theme.fg;
}

module.exports = { THEMES, M_STRIPE, LIGHTS, VERDICT, color };
