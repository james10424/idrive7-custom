"use strict";
/**
 * The "sdash" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgb } = require("../../engine/util");
const { scaleFrac, SPEED_SCALE } = require("../../car/scales");
const { MI_PER_KM } = require("../../car/consts");
const { packCfg } = require("../../engine/cfg");
const SDASH = require("./shader");

// the set-once uniforms packed into u_cfg (engine/cfg.js), in slot order
const CFG = [
  "u_geo",
  "u_k",
  "u_w",
  "u_inner",
  "u_scale",
  "u_ticks",
  "u_redFrom",
  "u_orange",
  "u_fuelSeg",
  "u_oilSeg",
  "u_hole",
  "u_holeR",
  "u_holeCut",
  "u_holeFade",
  "u_holeFadeK",
  "u_strip",
  "u_gapRail",
  "u_vbar0",
  "u_vbar1",
  "u_vbarC0",
  "u_vbarC1",
  "u_topEnd",
];
const PACKED = packCfg(SDASH, CFG);
/** @type {(define: string) => string} the shader with one pass's #define, packed */
const variant = (define) =>
  packCfg(SDASH.replace("#endif\nvarying", "#endif\n#define " + define + "\nvarying"), CFG);
// with a backdrop (a layout's "backdrop": true): the bench's bake draws only what never changes (SDASH_BAKE); the car
// draws the baked backdrop and only what moves over it (SDASH_LIVE)
const BAKE = variant("SDASH_BAKE");
const LIVE = variant("SDASH_LIVE");

const INNER_EXTRA_PX = 18; // default "inner": the inner line sits this much past the band width
const DEFAULT_RPM_MAX = 8000; // default rpm scale end
const HOLE_FADE_FEATHER_PX = 30; // "holeFade" default feather
const HOLE_FADE_DARKNESS = 0.85; // "holeFade" default darkness
const NEEDLE_STEPS = 500; // the gauges are resent only in steps of 1/500 of their scale
const OIL_MIN_C = 50; // the oil bar's bottom
const OIL_MID_C = 110; // its middle: the B58's running temperature
const OIL_MAX_C = 150; // its top
/** @type {number[]} */
const STRIP_MAX = [100, 10]; // "stripMax" default, left and right
const STRIP_STEPS = 50; // the strip's bars are resent in steps of 1/50
const GAP_MAX_M = 150; // the car-ahead gauge's default "max"
const GAP_STEPS = 300; // the car-ahead gauge is resent in steps of 1/300
const VBAR_STEPS = 100; // the upright boxes are resent in steps of 1/100
const ROUTE_STEPS = 400; // the route strip is resent in steps of 1/400

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the whole Sport theme (sdash/shader.js): "geo" [yTop, yBend, yBottom, xBend] and "k" [above, below, round] for the left bracket's outer line (the right one is mirrored), "band" width, "inner" (the inner line's distance from the outer one), "scale" [y of 0, y of the top mark], "ticks" [speed, rpm], "rpmMax" (speed follows SPEED_SCALE), "fuelSeg" / "oilSeg" [fullX, fullY, emptyX, emptyY], "strip" [left end x, y, h, slant], "topEnd" x; the middle is black, and the map window is cut see-through while "holeWhen" is on ("hole", "holeInset", "holeRadius" as fill), with "holeCut" [topW, topH, botW, botH]: a triangle in each corner of it kept black, mirrored left / right (BMW draws bits of its own Sport view there), and "holeMask" [x, y, w, h] in target px: a rectangle in it kept black (BMW's speed-limit sign at the window's left edge); "holeFade" [x, y, w, h, feather (30), darkness (0.85)]: a rectangle darkened in it, fading out over feather px (behind the gear, so the map doesn't run through it); "stripSignals" [left, right] turns the strip into two bars filled from its middle out (blue left, red right) by those signals over "stripMax" [l, r] ([100, 10]), "stripHotWhen": "kickdown" draws the left bar's last tenth red in kickdown "gapGauge" { box: [x, y, w, h], max (150 m) }: the car ahead as an upright box filled from the bottom up to the gap, red while closing faster than config.acc.closingKmh (10 km/h); "routeStrip": true makes the strip the route's progress while guiding (travelled / (travelled + left), filled from the right end leftwards); "vbars" [{ box: [x, y, w, h], signal, range: [lo, hi], color }] (up to 2): more upright boxes like it (boost, battery)`;

module.exports = {
  type: "sdash",
  fields: ["geo", "k", "band", "ticks", "fuelSeg", "oilSeg", "strip", "topEnd"],
  docs: DOCS,
  cfg: CFG,
  /**
   * @param {HudApp} hud
   * @returns {string}
   */
  shader(hud) {
    const backdrop = hud.backdrop;
    return backdrop ? (backdrop.bake ? BAKE : LIVE) : PACKED;
  },
  shaders: { sdash: PACKED, sdashBake: BAKE, sdashLive: LIVE },
  BAKE,
  /**
   * @param {HudApp} hud
   * @param {Widget} widget
   * @param {WidgetState} state
   */
  create(hud, widget, state) {
    const client = state.c,
      ref = state.ref,
      theme = hud.theme;
    const packer = hud._cfgPacker(client, ref, "sdash");
    // the baked backdrop under the live parts (engine/backdrop.js)
    const backdrop = hud.backdrop;
    if (backdrop && !backdrop.bake && backdrop.ref) client.bind(ref, "u_back", backdrop.ref);
    packer.uniform("u_size", [widget.w, widget.h]);
    packer.uniform("u_geo", widget.geo);
    packer.uniform("u_k", widget.k);
    packer.uniform("u_w", [widget.band]);
    packer.uniform("u_inner", [widget.inner || widget.band + INNER_EXTRA_PX]);
    packer.uniform("u_scale", widget.scale || [widget.geo[2], widget.geo[0]]);
    packer.uniform("u_ticks", widget.ticks);
    const [redFrom, orange] = hud._redMarks(widget.rpmMax || DEFAULT_RPM_MAX);
    packer.uniform("u_redFrom", [redFrom]);
    packer.uniform("u_orange", [orange]);
    packer.uniform("u_fuelSeg", widget.fuelSeg);
    packer.uniform("u_oilSeg", widget.oilSeg);
    packer.uniform("u_hole", hud._hole(widget));
    packer.uniform("u_holeR", [hud._holeRadius(widget)]);
    packer.uniform(
      "u_holeCut",
      Array.isArray(widget.holeCut) && widget.holeCut.length === 4
        ? widget.holeCut
        : [0, 0, 0, 0],
    );
    /** @type {(rect: *) => number[]} */
    const rel = (rect) =>
      Array.isArray(rect) && rect.length === 4
        ? [rect[0] - widget.x, rect[1] - widget.y, rect[2], rect[3]]
        : [0, 0, 0, 0];
    packer.uniform(
      "u_holeMask",
      rel(widget.holeMask).concat(rel(widget.holeOpen)),
      {
        type: "vec4",
      },
    );
    const holeFade =
      Array.isArray(widget.holeFade) && widget.holeFade.length >= 4
        ? widget.holeFade
        : null;
    packer.uniform(
      "u_holeFade",
      holeFade
        ? [
            holeFade[0] - widget.x,
            holeFade[1] - widget.y,
            holeFade[2],
            holeFade[3],
          ]
        : [0, 0, 0, 0],
    );
    packer.uniform("u_holeFadeK", [
      holeFade && isNum(holeFade[4]) ? holeFade[4] : HOLE_FADE_FEATHER_PX,
      holeFade && isNum(holeFade[5]) ? holeFade[5] : HOLE_FADE_DARKNESS,
    ]);
    packer.uniform("u_strip", widget.strip);
    const gapRail =
      widget.gapGauge && Array.isArray(widget.gapGauge.box)
        ? widget.gapGauge.box
        : null;
    packer.uniform(
      "u_gapRail",
      gapRail
        ? [gapRail[0] - widget.x, gapRail[1] - widget.y, gapRail[2], gapRail[3]]
        : [0, 0, 0, 0],
    );
    packer.uniform("u_gapG", [-1, 0]);
    const vbars = Array.isArray(widget.vbars) ? widget.vbars.slice(0, 2) : [];
    [0, 1].forEach((i) => {
      const vbar = vbars[i] && Array.isArray(vbars[i].box) ? vbars[i] : null;
      packer.uniform(
        "u_vbar" + i,
        vbar
          ? [
              vbar.box[0] - widget.x,
              vbar.box[1] - widget.y,
              vbar.box[2],
              vbar.box[3],
            ]
          : [0, 0, 0, 0],
      );
      packer.uniform(
        "u_vbarC" + i,
        rgb(color(theme, (vbar && vbar.color) || "fg")),
      );
    });
    packer.uniform("u_vbarV", [-1, -1]);
    packer.uniform(
      "u_stripFill",
      Array.isArray(widget.stripSignals) ? [0, 0, 0] : [-1, 0, 0],
    );
    packer.uniform("u_stripRoute", [-1]);
    packer.uniform("u_topEnd", [widget.topEnd]);
    packer.flush();
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, state, now, force) {
    const widget = state.w;
    const usUnits = hud.setting("units") === "us";
    const speed = hud._raw("speed"),
      rpm = hud._raw("rpm"),
      fuel = hud._raw("fuel"),
      oil = hud._raw("oil");
    /** @type {(value: number) => number} */
    const quantize = (value) =>
      Math.round(Math.min(1, Math.max(0, value)) * NEEDLE_STEPS) / NEEDLE_STEPS;
    const vals = [
      quantize(
        isNum(speed)
          ? scaleFrac(
              usUnits ? speed * MI_PER_KM : speed,
              SPEED_SCALE[usUnits ? "us" : "metric"],
            )
          : 0,
      ),
      quantize(isNum(rpm) ? rpm / (widget.rpmMax || DEFAULT_RPM_MAX) : 0),
      quantize(isNum(fuel) ? fuel : 0),
      // oil: 50..150 C with 110 (the B58's running temperature) at the bar's middle, each half linear
      quantize(
        isNum(oil)
          ? oil <= OIL_MID_C
            ? (0.5 * (oil - OIL_MIN_C)) / (OIL_MID_C - OIL_MIN_C)
            : 0.5 + (0.5 * (oil - OIL_MID_C)) / (OIL_MAX_C - OIL_MID_C)
          : 0,
      ),
    ];
    // the strip's two bars: each signal over its "stripMax", in 50 steps
    const stripSignals = Array.isArray(widget.stripSignals)
        ? widget.stripSignals
        : null,
      stripMax = Array.isArray(widget.stripMax) ? widget.stripMax : STRIP_MAX;
    const strip = stripSignals
      ? [0, 1].map((i) => {
          const value = stripSignals[i] ? hud._raw(stripSignals[i]) : null;
          return isNum(value)
            ? Math.round(
                Math.min(1, Math.max(0, value / (stripMax[i] || 1))) * STRIP_STEPS,
              ) / STRIP_STEPS
            : 0;
        })
      : null;
    const hot =
      !!stripSignals && widget.stripHotWhen === "kickdown" && hud._kickdown();
    // the car-ahead gauge: the gap over its "max" m, in 300 steps; red while closing fast
    const gap = widget.gapGauge ? hud._acc("gap") : null;
    const gapFrac = isNum(gap)
      ? Math.round(
          Math.min(1, Math.max(0, gap / (widget.gapGauge.max || GAP_MAX_M))) * GAP_STEPS,
        ) / GAP_STEPS
      : -1;
    const gHot = gapFrac >= 0 && hud._closing();
    // boost and battery boxes: each signal over its "range" [lo, hi], in 100 steps
    const vbv =
      Array.isArray(widget.vbars) && widget.vbars.length
        ? [0, 1].map((i) => {
            const vbar = widget.vbars[i],
              value = vbar && vbar.signal ? hud._raw(vbar.signal) : null,
              range = (vbar && vbar.range) || [0, 1];
            return isNum(value)
              ? Math.round(
                  Math.min(
                    1,
                    Math.max(0, (value - range[0]) / (range[1] - range[0])),
                  ) * VBAR_STEPS,
                ) / VBAR_STEPS
              : -1;
          })
        : null;
    // while guiding, "routeStrip" turns the strip into the route's progress (filled from the right), in 400 steps
    const routeProgress = widget.routeStrip ? hud._routeProgress() : null;
    const route = isNum(routeProgress)
      ? Math.round(routeProgress * ROUTE_STEPS) / ROUTE_STEPS
      : -1;
    const key =
      vals.join("|") +
      (strip ? "|" + strip.join("|") + (hot ? "h" : "") : "") +
      (widget.gapGauge ? "|" + gapFrac + (gHot ? "c" : "") : "") +
      (vbv ? "|" + vbv.join("|") : "") +
      "|" +
      route;
    if (!force && key === state.last) return;
    state.last = key;
    if (widget.gapGauge)
      state.c.uniform(state.ref, "u_gapG", [gapFrac, gHot ? 1 : 0]);
    if (vbv) state.c.uniform(state.ref, "u_vbarV", vbv);
    if (strip)
      state.c.uniform(state.ref, "u_stripFill", [
        strip[0],
        strip[1],
        hot ? 1 : 0,
      ]);
    state.c.uniform(state.ref, "u_stripRoute", [route]);
    state.c.uniform(state.ref, "u_speed", [vals[0]]);
    state.c.uniform(state.ref, "u_rpm", [vals[1]]);
    state.c.uniform(state.ref, "u_fuel", [vals[2]]);
    state.c.uniform(state.ref, "u_oil", [vals[3]]);
  },
};
