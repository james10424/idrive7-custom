"use strict";
/**
 * The "sdash" widget: an effect layer.
 */
const { color } = require("../../hud_themes");
const { isNum, rgb } = require("../../engine/util");
const { scaleFrac, SPEED_SCALE } = require("../../car/scales");
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

/** @typedef {import("../../engine/app").Widget} Widget */
/** @typedef {import("../../engine/app").WidgetState} WidgetState */
/** @typedef {import("../../engine/app").App} HudApp */

const DOCS = `effect layer; the whole Sport theme (sdash/shader.js): "geo" [yTop, yBend, yBottom, xBend] and "k" [above, below, round] for the left bracket's outer line (the right one is mirrored), "band" width, "inner" (the inner line's distance from the outer one), "scale" [y of 0, y of the top mark], "ticks" [speed, rpm], "rpmMax" (speed follows SPEED_SCALE), "fuelSeg" / "oilSeg" [fullX, fullY, emptyX, emptyY], "strip" [left end x, y, h, slant], "topEnd" x; the middle is black, and the map window is cut see-through while "holeWhen" is on ("hole", "holeInset", "holeRadius" as fill), with "holeCut" [topW, topH, botW, botH]: a triangle in each corner of it kept black, mirrored left / right (BMW draws bits of its own Sport view there), and "holeMask" [x, y, w, h] in target px: a rectangle in it kept black (BMW's speed-limit sign at the window's left edge); "holeFade" [x, y, w, h, feather (30), darkness (0.85)]: a rectangle darkened in it, fading out over feather px (behind the gear, so the map doesn't run through it); "stripSignals" [left, right] turns the strip into two bars filled from its middle out (blue left, red right) by those signals over "stripMax" [l, r] ([100, 10]), "stripHotWhen": "kickdown" draws the left bar's last tenth red in kickdown "gapGauge" { box: [x, y, w, h], max (150 m) }: the car ahead as an upright box filled from the bottom up to the gap, red while closing faster than config.acc.closingKmh (10 km/h); "routeStrip": true makes the strip the route's progress while guiding (travelled / (travelled + left), filled from the right end leftwards); "vbars" [{ box: [x, y, w, h], signal, range: [lo, hi], color }] (up to 2): more upright boxes like it (boost, battery)`;

module.exports = {
  type: "sdash",
  fields: ["geo", "k", "band", "ticks", "fuelSeg", "oilSeg", "strip", "topEnd"],
  docs: DOCS,
  cfg: CFG,
  /** @returns {string} */
  shader() {
    return PACKED;
  },
  shaders: { sdash: PACKED },
  /**
   * @param {HudApp} hud
   * @param {Widget} w
   * @param {WidgetState} x
   */
  create(hud, w, x) {
    const c = x.c,
      ref = x.ref,
      t = hud.theme;
    const pk = hud._cfgPacker(c, ref, "sdash");
    pk.uniform("u_size", [w.w, w.h]);
    pk.uniform("u_geo", w.geo);
    pk.uniform("u_k", w.k);
    pk.uniform("u_w", [w.band]);
    pk.uniform("u_inner", [w.inner || w.band + 18]);
    pk.uniform("u_scale", w.scale || [w.geo[2], w.geo[0]]);
    pk.uniform("u_ticks", w.ticks);
    const [redFrom, orange] = hud._redMarks(w.rpmMax || 8000);
    pk.uniform("u_redFrom", [redFrom]);
    pk.uniform("u_orange", [orange]);
    pk.uniform("u_fuelSeg", w.fuelSeg);
    pk.uniform("u_oilSeg", w.oilSeg);
    pk.uniform("u_hole", hud._hole(w));
    pk.uniform("u_holeR", [hud._holeRadius(w)]);
    pk.uniform(
      "u_holeCut",
      Array.isArray(w.holeCut) && w.holeCut.length === 4
        ? w.holeCut
        : [0, 0, 0, 0],
    );
    /** @type {(r: *) => number[]} */
    const rel = (r) =>
      Array.isArray(r) && r.length === 4
        ? [r[0] - w.x, r[1] - w.y, r[2], r[3]]
        : [0, 0, 0, 0];
    pk.uniform("u_holeMask", rel(w.holeMask).concat(rel(w.holeOpen)), {
      type: "vec4",
    });
    const hf =
      Array.isArray(w.holeFade) && w.holeFade.length >= 4 ? w.holeFade : null;
    pk.uniform(
      "u_holeFade",
      hf ? [hf[0] - w.x, hf[1] - w.y, hf[2], hf[3]] : [0, 0, 0, 0],
    );
    pk.uniform("u_holeFadeK", [
      hf && isNum(hf[4]) ? hf[4] : 30,
      hf && isNum(hf[5]) ? hf[5] : 0.85,
    ]);
    pk.uniform("u_strip", w.strip);
    const gg =
      w.gapGauge && Array.isArray(w.gapGauge.box) ? w.gapGauge.box : null;
    pk.uniform(
      "u_gapRail",
      gg ? [gg[0] - w.x, gg[1] - w.y, gg[2], gg[3]] : [0, 0, 0, 0],
    );
    pk.uniform("u_gapG", [-1, 0]);
    const vb = Array.isArray(w.vbars) ? w.vbars.slice(0, 2) : [];
    [0, 1].forEach((i) => {
      const b = vb[i] && Array.isArray(vb[i].box) ? vb[i] : null;
      pk.uniform(
        "u_vbar" + i,
        b ? [b.box[0] - w.x, b.box[1] - w.y, b.box[2], b.box[3]] : [0, 0, 0, 0],
      );
      pk.uniform("u_vbarC" + i, rgb(color(t, (b && b.color) || "fg")));
    });
    pk.uniform("u_vbarV", [-1, -1]);
    pk.uniform(
      "u_stripFill",
      Array.isArray(w.stripSignals) ? [0, 0, 0] : [-1, 0, 0],
    );
    pk.uniform("u_stripRoute", [-1]);
    pk.uniform("u_topEnd", [w.topEnd]);
    pk.flush();
  },
  /**
   * @param {HudApp} hud
   * @param {WidgetState} x
   * @param {number} now
   * @param {boolean} force
   */
  update(hud, x, now, force) {
    const w = x.w;
    const us = hud.setting("units") === "us";
    const sp = hud._raw("speed"),
      rpm = hud._raw("rpm"),
      fuel = hud._raw("fuel"),
      oil = hud._raw("oil");
    /** @type {(v: number) => number} */
    const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 500) / 500;
    const vals = [
      q(
        isNum(sp)
          ? scaleFrac(
              us ? sp * 0.621371 : sp,
              SPEED_SCALE[us ? "us" : "metric"],
            )
          : 0,
      ),
      q(isNum(rpm) ? rpm / (w.rpmMax || 8000) : 0),
      q(isNum(fuel) ? fuel : 0),
      // oil: 50..150 C with 110 (the B58's running temperature) at the bar's middle, each half linear
      q(
        isNum(oil)
          ? oil <= 110
            ? (0.5 * (oil - 50)) / 60
            : 0.5 + (0.5 * (oil - 110)) / 40
          : 0,
      ),
    ];
    // the strip's two bars: each signal over its "stripMax", in 50 steps
    const ss = Array.isArray(w.stripSignals) ? w.stripSignals : null,
      sm = Array.isArray(w.stripMax) ? w.stripMax : [100, 10];
    const strip = ss
      ? [0, 1].map((i) => {
          const v = ss[i] ? hud._raw(ss[i]) : null;
          return isNum(v)
            ? Math.round(Math.min(1, Math.max(0, v / (sm[i] || 1))) * 50) / 50
            : 0;
        })
      : null;
    const hot = !!ss && w.stripHotWhen === "kickdown" && hud._kickdown();
    // the car-ahead gauge: the gap over its "max" m, in 300 steps; red while closing fast
    const gm = w.gapGauge ? hud._acc("gap") : null;
    const gv = isNum(gm)
      ? Math.round(
          Math.min(1, Math.max(0, gm / (w.gapGauge.max || 150))) * 300,
        ) / 300
      : -1;
    const gHot = gv >= 0 && hud._closing();
    // boost and battery boxes: each signal over its "range" [lo, hi], in 100 steps
    const vbv =
      Array.isArray(w.vbars) && w.vbars.length
        ? [0, 1].map((i) => {
            const b = w.vbars[i],
              v = b && b.signal ? hud._raw(b.signal) : null,
              r = (b && b.range) || [0, 1];
            return isNum(v)
              ? Math.round(
                  Math.min(1, Math.max(0, (v - r[0]) / (r[1] - r[0]))) * 100,
                ) / 100
              : -1;
          })
        : null;
    // while guiding, "routeStrip" turns the strip into the route's progress (filled from the right), in 400 steps
    const rp = w.routeStrip ? hud._routeProgress() : null;
    const route = isNum(rp) ? Math.round(rp * 400) / 400 : -1;
    const key =
      vals.join("|") +
      (strip ? "|" + strip.join("|") + (hot ? "h" : "") : "") +
      (w.gapGauge ? "|" + gv + (gHot ? "c" : "") : "") +
      (vbv ? "|" + vbv.join("|") : "") +
      "|" +
      route;
    if (!force && key === x.last) return;
    x.last = key;
    if (w.gapGauge) x.c.uniform(x.ref, "u_gapG", [gv, gHot ? 1 : 0]);
    if (vbv) x.c.uniform(x.ref, "u_vbarV", vbv);
    if (strip)
      x.c.uniform(x.ref, "u_stripFill", [strip[0], strip[1], hot ? 1 : 0]);
    x.c.uniform(x.ref, "u_stripRoute", [route]);
    x.c.uniform(x.ref, "u_speed", [vals[0]]);
    x.c.uniform(x.ref, "u_rpm", [vals[1]]);
    x.c.uniform(x.ref, "u_fuel", [vals[2]]);
    x.c.uniform(x.ref, "u_oil", [vals[3]]);
  },
};
