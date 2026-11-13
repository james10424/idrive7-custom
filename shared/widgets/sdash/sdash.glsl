// The Sport theme in one cluster-render "effect" layer (GLSL ES 1.00), after BMW's Live Cockpit Sport view:
// a blue speed bracket left and a red rev bracket right (the left one mirrored). Each is a thin bright outer
// line, a band that fills from the bottom (white marker at the value), a dark gap and a thin inner line round a
// black middle: plain black, or BMW's map through a see-through rounded hole (u_hole; only the fuel and oil bars
// and the bottom strip draw over it). Two-tone fuel and oil bars inside the brackets, a blue / red strip at the bottom
// (optionally two bars from its middle out: the throttle left, the brake right). v_uv (0,0) is
// the top-left. The backdrop is pure black: the car brightens dark tints (seen Nov 5 2026), so no dark panels.
// Three passes from this one file: with SDASH_BAKE only what never changes while driving (the black with the map window
// cut in its alpha, the brackets' lines and label marks, the bars' rails, the bottom line), which the bench bakes with
// the static labels into the backdrop (hud/backdrops/<layout>-<units>[-map].etc2, engine/backdrop.js); with SDASH_LIVE
// that backdrop (u_back) and only what moves: the brackets' bands (filled, the band past the value, the marker) under
// its marks and lines, the redline over them, the bars' bodies, the upright boxes and the bottom strip; with neither,
// everything.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_geo;       // outer line: y at the top, y at the bend, y at the bottom, x at the bend (left side)
uniform vec3 u_k;         // x per y px above the bend, below it, bend roundness px
uniform float u_w;        // band width
uniform float u_inner;    // the inner line's distance from the outer line
uniform vec2 u_scale;     // y of the scale's 0 and of its top mark
uniform vec2 u_ticks;     // marks left (speed), right (rpm)
uniform float u_speed;    // 0..1 along the scale
uniform float u_rpm;      // 0..1
uniform float u_redFrom;  // 0..1 (the redline)
uniform float u_orange;   // 0..1, yellow marks from here to the redline
uniform float u_fuel;     // 0..1
uniform float u_oil;      // 0..1
uniform vec4 u_fuelSeg;   // full end x, y, empty end x, y
uniform vec4 u_oilSeg;
uniform vec4 u_hole;      // map window x, y, w, h, already inset (w 0 = none)
uniform float u_holeR;    // the hole's corner radius px
uniform vec4 u_holeCut;   // corners kept black: top w, h and bottom w, h px of a triangle in each, mirrored left / right
uniform vec4 u_holeMask[2]; // [0] a rectangle kept black inside the window, [1] one opened past its edge: x, y, w, h px
                          // (w 0 = none; one array, as the layer is at cluster-render's 32 uniform names)
uniform vec4 u_holeFade;  // a rectangle darkened inside the window, fading out round it: x, y, w, h px (w 0 = none)
uniform vec2 u_holeFadeK; // that fade: feather px, darkness 0..1 at its middle
uniform vec4 u_strip;     // bottom strip: left end x, top y, height, slant px
uniform vec3 u_stripFill; // the strip as two bars from the middle out: blue left 0..1, red right 0..1, its last tenth red
                          // (kickdown) when z > 0.5; x < 0 = both halves lit (no signals)
uniform float u_stripRoute; // >= 0: the strip is the route's progress 0..1, filled blue from its right end leftwards (< 0: off)
uniform float u_topEnd;   // the top lines run from the bracket to this x (left; mirrored on the right)
uniform vec4 u_gapRail;   // the car-ahead gauge's box: x, y, w, h (w 0 = none)
uniform vec2 u_gapG;      // its fill 0..1 up the box (< 0: no car), red when y > 0.5 (closing fast)
uniform vec4 u_vbar0;     // up to two more upright level boxes ("vbars", boost and battery): x, y, w, h (w 0 = none)
uniform vec4 u_vbar1;
uniform vec2 u_vbarV;     // their fills 0..1 (< 0: no value)
uniform vec3 u_vbarC0;    // their fill colours
uniform vec3 u_vbarC1;
#ifdef SDASH_LIVE
uniform sampler2D u_back; // the baked backdrop (ETC2, the layer's size; see-through in the map window when it is open)
#endif

// speed, after iDrive 8 (photo, Nov 8 2026): a cyan line, a medium blue band, filled pale aqua deepening to cyan
const vec3 BLUE_LINE = vec3(0.24, 0.72, 1.0);
const vec3 BLUE_BAND = vec3(0.01, 0.2, 0.52);    // past the value: stock iDrive 7 navy (sharp car photo, Nov 8 2026)
const vec3 BLUE_LIT = vec3(0.12, 0.6, 0.81);
const vec3 BLUE_LIT2 = vec3(0.05, 0.88, 0.95);
const vec3 BLUE_IN = vec3(0.2, 0.45, 0.98);
const vec3 RED_LINE = vec3(0.95, 0.12, 0.16);
const vec3 RED_BAND = vec3(0.25, 0.07, 0.13);    // rpm past the value: stock dark maroon (sharp car photo, Nov 8 2026)
const vec3 RED_LIT = vec3(0.96, 0.14, 0.31);
const vec3 RED_IN = vec3(0.86, 0.08, 0.13);

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float segH(vec2 p, vec2 a, vec2 b) { vec2 ba = b - a; return clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0); }

float outerX(float y) {
    float dy = y - u_geo.y;
    float k = dy < 0.0 ? u_k.x : u_k.y;
    return u_geo.w + k * (sqrt(dy * dy + u_k.z * u_k.z) - u_k.z);
}
float outerSlope(float y) {
    float dy = y - u_geo.y;
    float k = dy < 0.0 ? u_k.x : u_k.y;
    return k * dy / sqrt(dy * dy + u_k.z * u_k.z);
}
// px from the outer line, inwards (perpendicular)
float dIn(vec2 q) { return (q.x - outerX(q.y)) / sqrt(1.0 + outerSlope(q.y) * outerSlope(q.y)); }

// one bracket in the left frame (q mirrored for the right one)
// band: its colour past the value, drawn at offA; lit: the fill's colour at the bottom, lit2 at the value
vec4 bracket(vec2 q, float val, float redFrom, float orange, float ticks, vec3 line, vec3 band, float offA, vec3 lit, vec3 lit2, vec3 inner, vec4 c) {
    float d = dIn(q);
    float t = (u_scale.x - q.y) / (u_scale.x - u_scale.y);    // 0 at the scale's 0
    bool inY = q.y > u_geo.x + 5.0 && q.y < u_geo.z - 4.0;
    // outer line, a dark gap (the redline marks), then the band against the inner line (BMW's own Sport view, car photo
    // Nov 8 2026): the band runs from b0 to b1 px inwards
    float b1 = u_inner - 1.5, b0 = b1 - u_w, f0 = 3.8;
    float lit_ = inY && t <= val && val > 0.002 ? 1.0 : 0.0;
    // up to the value the fill spans the whole width, outer line to inner line (iDrive 8 running, photo Nov 8 2026); past
    // it only the band against the inner line shows, the gap dark (stock photo)
    float inB = (inY ? 1.0 : 0.0) * cov(-(d - (lit_ > 0.5 ? f0 : b0))) * cov(d - b1);
    if (inB > 0.0) {
        vec3 col = band;
        float a = offA;
        if (lit_ > 0.5) {
            a = 0.96;
            col = mix(lit, lit2, clamp(t / max(val, 0.01), 0.0, 1.0));
            col = mix(col, vec3(1.0), 0.08 * (1.0 - clamp((d - f0) / (b1 - f0), 0.0, 1.0)));
        }
        c = over(vec4(col, a * inB), c);
    }
    // the white marker at the value, across the full width
    float yv = u_scale.x - val * (u_scale.x - u_scale.y);
    if (inY && val > 0.002 && d > f0 && d < b1) c = over(vec4(1.0, 1.0, 1.0, cov(abs(q.y - yv) - 2.0)), c);
    // a mark at every label: a short thick rounded dash in the middle of the gap, clear of the outer line and the band
    // (stock photo, Nov 8 2026); over the fill below the value
    if (inY) {
        float kk = floor(t * ticks + 0.5);
        float yk = u_scale.x - kk / ticks * (u_scale.x - u_scale.y);
        float gm = 0.5 * (f0 + 3.0 + b0), gh = max(0.5, 0.5 * (b0 - f0 - 3.0) - 3.5);   // the gap's middle, the dash's half length
        float td = length(vec2(max(abs(d - gm) - gh, 0.0), q.y - yk)) - 2.2;
        if (kk >= 0.0 && kk <= ticks) c = over(vec4(line, 0.95 * cov(td)), c);
    }
    if (inY && d > 4.0 && d < b0) {
        // in the gap by the outer line: the redline, yellow dashes then a solid red line
        if (redFrom < 1.5 && d > 6.0 && d < 11.0) {
            if (t >= redFrom && t <= 1.02) c = over(vec4(1.0, 0.2, 0.2, 1.0), c);
            else if (t >= orange && t < redFrom && mod(q.y, 16.0) < 7.0) c = over(vec4(1.0, 0.85, 0.1, 1.0), c);
        }
    }
    // the outer line, its top run and its bottom run
    // the slanted line stops at the top and bottom runs (it ran 6 px past them: a spur at each corner, car photo Nov 8 2026)
    float o = q.y > u_geo.x - 1.0 && q.y < u_geo.z + 1.0 ? cov(abs(d - 0.5) - 3.0) : 0.0;   // ~6 px, twice the inner line (car photo, Nov 8 2026)
    vec2 tl = vec2(outerX(u_geo.x), u_geo.x), bl = vec2(outerX(u_geo.z), u_geo.z);
    o = max(o, cov(segD(q, tl, vec2(u_topEnd, u_geo.x)) - 3.0));
    o = max(o, cov(segD(q, bl, bl + vec2(u_inner + 40.0, 0.0)) - 3.0));
    c = over(vec4(line, 0.35 * exp(-abs(d) / 5.0) * (inY ? 1.0 : 0.0) * step(d, 0.0)), c);
    c = over(vec4(line, o), c);
    // the inner line: down the bracket from the top run to the bottom, no top run of its own (BMW's Sport view has a
    // single line along the top, car photo Nov 8 2026)
    float il = (q.y > u_geo.x && q.y < u_geo.z - 6.0) ? cov(abs(d - u_inner) - 1.6) : 0.0;
    c = over(vec4(inner, 0.95 * il), c);
    return c;
}

// a slanted level bar from the empty end b to the full end a, as BMW's own Sport view draws fuel and oil (car photo,
// Nov 8 2026): flat (horizontal) ends, four segments split by dark lines, lit white from the empty end up to the
// value, the rest grey, and a thin rail beside it on the side away from its labels (rail -1: left of a bar leaning
// left, as fuel; +1: right, as oil). zones > 0.5: the rail's last quarter-segment at the cold end is blue and at the
// hot end red, as BMW's oil gauge.
vec4 bar(vec2 p, vec4 s, float val, float zones, float rail, vec4 c) {
    vec2 a = s.xy, b = s.zw;
    float yt = min(a.y, b.y), yb = max(a.y, b.y);
    if (p.y < yt - 4.0 || p.y > yb + 4.0) return c;
    // x of the bar's centre line at this y, and the horizontal distance from it
    float xc = mix(b.x, a.x, (b.y - p.y) / (b.y - a.y));
    float k = abs((a.x - b.x) / (a.y - b.y)), sec = sqrt(1.0 + k * k);   // horizontal px per perpendicular px
    float side = (p.x - xc) / sec;                                       // perpendicular px, + right of the line
    if (abs(side) > 22.0) return c;
    float ends = cov(yt - p.y) * cov(p.y - yb);                          // flat ends
    float h = (b.y - p.y) / (b.y - a.y);                                 // 0 empty .. 1 full, along y
#ifndef SDASH_BAKE
    float seg = fract(h * 4.0);
    float div = cov(min(seg, 1.0 - seg) * (yb - yt) / 4.0 - 1.1);        // dark lines between the four segments
#endif
#ifndef SDASH_BAKE
    // the body (live), beside the rail: they never overlap, so either can be drawn first
    float body = cov(abs(side) - 10.0) * ends;
    vec3 off = vec3(0.30, 0.32, 0.37), edge = vec3(0.47, 0.49, 0.55);
    vec3 lit = mix(vec3(0.78, 0.8, 0.84), vec3(0.97, 0.98, 1.0), clamp(h / max(val, 0.05), 0.0, 1.0));
    bool on = val > 0.001 && h <= val;
    vec3 col = on ? lit : mix(off, edge, 1.0 - cov(abs(side) - 8.5));
    c = over(vec4(col, (on ? 1.0 : 0.92) * body), c);
    c = over(vec4(0.0, 0.0, 0.0, 0.85 * body * div * step(0.02, h) * step(h, 0.98)), c);
#endif
#ifndef SDASH_LIVE
    // the rail (baked)
    float rs = side - rail * 15.0;
    float r = cov(abs(rs) - 1.3) * ends;
    vec3 rc = vec3(0.9, 0.92, 0.96);
    if (zones > 0.5 && h < 0.12) rc = vec3(0.25, 0.5, 1.0);
    if (zones > 0.5 && h > 0.9) rc = vec3(1.0, 0.2, 0.22);
    c = over(vec4(rc, 0.95 * r), c);
#endif
    return c;
}


// With a backdrop, a bracket in two parts. Its band zone (between the outer line's inside and the inner line, where the
// fill, the band past the value and the marker draw) is live, opaque over black; the backdrop holds the rest, and in
// the zone only the marks and lines drawn over the band (see-through round them), so the backdrop over the zone is
// bracket() without its redline, which the live pass draws last (over the marks, as bracket() does).
bool inZone(vec2 q, float d) { return q.y > u_geo.x + 5.0 && q.y < u_geo.z - 4.0 && d > 2.5 && d < u_inner - 0.5; }
#ifdef SDASH_LIVE
// the zone's live part over black, as bracket() draws it (inside the zone inY holds)
vec4 bracketFill(vec2 q, float d, float val, vec3 band, vec3 lit, vec3 lit2) {
    vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
    float t = (u_scale.x - q.y) / (u_scale.x - u_scale.y);
    float b1 = u_inner - 1.5, b0 = b1 - u_w, f0 = 3.8;
    bool on = t <= val && val > 0.002;
    float inB = cov(-(d - (on ? f0 : b0))) * cov(d - b1);
    if (inB > 0.0) {
        vec3 col = band;
        float a = 0.95;
        if (on) {
            a = 0.96;
            col = mix(lit, lit2, clamp(t / max(val, 0.01), 0.0, 1.0));
            col = mix(col, vec3(1.0), 0.08 * (1.0 - clamp((d - f0) / (b1 - f0), 0.0, 1.0)));
        }
        c = over(vec4(col, a * inB), c);
    }
    float yv = u_scale.x - val * (u_scale.x - u_scale.y);
    if (val > 0.002 && d > f0 && d < b1) c = over(vec4(1.0, 1.0, 1.0, cov(abs(q.y - yv) - 2.0)), c);
    return c;
}
// the rpm bracket's redline in the gap by the outer line: yellow dashes, then a solid red line
vec4 redline(vec2 q, float d, vec4 c) {
    float t = (u_scale.x - q.y) / (u_scale.x - u_scale.y);
    if (u_redFrom < 1.5 && d > 6.0 && d < 11.0 && d < u_inner - 1.5 - u_w) {
        if (t >= u_redFrom && t <= 1.02) c = over(vec4(1.0, 0.2, 0.2, 1.0), c);
        else if (t >= u_orange && t < u_redFrom && mod(q.y, 16.0) < 7.0) c = over(vec4(1.0, 0.85, 0.1, 1.0), c);
    }
    return c;
}
#endif
#ifdef SDASH_BAKE
// what bracket() draws over the band: the label marks, the glow, the outer line with its runs and the inner line
vec4 bracketMarks(vec2 q, float d, float ticks, vec3 line, vec3 inner, vec4 c) {
    float t = (u_scale.x - q.y) / (u_scale.x - u_scale.y);
    bool inY = q.y > u_geo.x + 5.0 && q.y < u_geo.z - 4.0;
    float b1 = u_inner - 1.5, b0 = b1 - u_w, f0 = 3.8;
    if (inY) {
        float kk = floor(t * ticks + 0.5);
        float yk = u_scale.x - kk / ticks * (u_scale.x - u_scale.y);
        float gm = 0.5 * (f0 + 3.0 + b0), gh = max(0.5, 0.5 * (b0 - f0 - 3.0) - 3.5);
        float td = length(vec2(max(abs(d - gm) - gh, 0.0), q.y - yk)) - 2.2;
        if (kk >= 0.0 && kk <= ticks) c = over(vec4(line, 0.95 * cov(td)), c);
    }
    float o = q.y > u_geo.x - 1.0 && q.y < u_geo.z + 1.0 ? cov(abs(d - 0.5) - 3.0) : 0.0;
    vec2 tl = vec2(outerX(u_geo.x), u_geo.x), bl = vec2(outerX(u_geo.z), u_geo.z);
    o = max(o, cov(segD(q, tl, vec2(u_topEnd, u_geo.x)) - 3.0));
    o = max(o, cov(segD(q, bl, bl + vec2(u_inner + 40.0, 0.0)) - 3.0));
    c = over(vec4(line, 0.35 * exp(-abs(d) / 5.0) * (inY ? 1.0 : 0.0) * step(d, 0.0)), c);
    c = over(vec4(line, o), c);
    float il = (q.y > u_geo.x && q.y < u_geo.z - 6.0) ? cov(abs(d - u_inner) - 1.6) : 0.0;
    c = over(vec4(inner, 0.95 * il), c);
    return c;
}
#endif

// an upright box filled from the bottom up to f (0..1; < 0 none) in fc over a grey track, a lighter outline on the track
vec4 vbox(vec2 p, vec4 r, float f, vec3 fc, vec4 c) {
    if (r.z <= 0.0) return c;
    vec2 bq = abs(p - (r.xy + r.zw * 0.5)) - r.zw * 0.5;
    float bd = length(max(bq, 0.0)) + min(max(bq.x, bq.y), 0.0);
    if (bd > 2.0) return c;
    float h = (r.y + r.w - p.y) / r.w;
    bool on = f > 0.001 && h <= f;
    c = over(vec4(on ? fc : vec3(0.30, 0.32, 0.37), (on ? 1.0 : 0.92) * cov(bd)), c);
    if (!on) c = over(vec4(0.55, 0.57, 0.62, 0.9 * cov(abs(bd) - 0.8)), c);
    return c;
}

void main() {
    vec2 p = v_uv * u_size;
    vec2 pm = vec2(u_size.x - p.x, p.y);
#ifndef SDASH_BAKE
#ifndef SDASH_LIVE
    vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
    c = bracket(p, u_speed, 2.0, 2.0, u_ticks.x, BLUE_LINE, BLUE_BAND, 0.95, BLUE_LIT, BLUE_LIT2, BLUE_IN, c);
    c = bracket(pm, u_rpm, u_redFrom, u_orange, u_ticks.y, RED_LINE, RED_BAND, 0.95, RED_LIT * 0.85, RED_LIT, RED_IN, c);
#endif
#endif
#ifdef SDASH_BAKE
    // with a backdrop, one bracket a pixel (nothing of either crosses the middle)
    bool right = p.x > u_size.x * 0.5;
    vec2 q = right ? pm : p;
    // the black, see-through in the brackets' band zones (drawn live) and the map window
    float d = dIn(q);
    vec4 c = vec4(0.0, 0.0, 0.0, inZone(q, d) ? 0.0 : 1.0);
    c = bracketMarks(q, d, right ? u_ticks.y : u_ticks.x, right ? RED_LINE : BLUE_LINE, right ? RED_IN : BLUE_IN, c);
#endif
#ifndef SDASH_LIVE
    // the map window: a rounded hole cut out of the backdrop and brackets (c's alpha), so BMW's map shows clean; the
    // fuel and oil bars and the bottom strip draw over it, as BMW's own Sport view lays them beside the map
    if (u_hole.z > 0.0) {
        vec2 hs = u_hole.zw * 0.5;
        vec2 q = abs(p - (u_hole.xy + hs)) - (hs - vec2(u_holeR));
        float hd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_holeR;
        // BMW's own Sport view draws bracket ends, a gauge icon and hatched dial ends in the window's corners (car
        // photo, Nov 7 2026): a triangle in each stays black (distance into it > 0)
        vec2 lp = p - u_hole.xy;
        lp.x = min(lp.x, u_hole.z - lp.x);
        if (u_holeCut.x > 0.0)
            hd = max(hd, (1.0 - lp.x / u_holeCut.x - lp.y / u_holeCut.y) * u_holeCut.x * u_holeCut.y / length(u_holeCut.xy));
        if (u_holeCut.z > 0.0)
            hd = max(hd, (1.0 - lp.x / u_holeCut.z - (u_hole.w - lp.y) / u_holeCut.w) * u_holeCut.z * u_holeCut.w / length(u_holeCut.zw));
        // and a rectangle ("holeMask"): BMW's speed-limit sign at the window's left edge (car photo, Nov 8 2026)
        // and one opened past the window's edge ("holeOpen"): BMW's speed is right-aligned at x ~546 and its hundreds
        // digit reaches left past the window (104 read 04, car photo Nov 9 2026)
        if (u_holeMask[1].z > 0.0) {
            vec2 oq = abs(p - (u_holeMask[1].xy + u_holeMask[1].zw * 0.5)) - u_holeMask[1].zw * 0.5;
            hd = min(hd, length(max(oq, 0.0)) + min(max(oq.x, oq.y), 0.0));
        }
        if (u_holeMask[0].z > 0.0) {
            vec2 mq = abs(p - (u_holeMask[0].xy + u_holeMask[0].zw * 0.5)) - u_holeMask[0].zw * 0.5;
            hd = max(hd, -(length(max(mq, 0.0)) + min(max(mq.x, mq.y), 0.0)));
        }
        c.a *= clamp(hd + 0.5, 0.0, 1.0);
        // a soft dark patch behind our gear, so BMW's map lines don't run through it (car photo, Nov 8 2026)
        if (u_holeFade.z > 0.0) {
            vec2 fq = abs(p - (u_holeFade.xy + u_holeFade.zw * 0.5)) - u_holeFade.zw * 0.5;
            float fd = length(max(fq, 0.0)) + min(max(fq.x, fq.y), 0.0);
            c.a = max(c.a, u_holeFadeK.y * (1.0 - smoothstep(0.0, u_holeFadeK.x, fd)));
        }
    }
#endif
#ifdef SDASH_LIVE
    bool right = p.x > u_size.x * 0.5;
    vec2 q = right ? pm : p;
    vec4 c = texture2D(u_back, v_uv);
    float d = dIn(q);
    if (inZone(q, d)) {
        c = over(c, bracketFill(q, d, right ? u_rpm : u_speed, right ? RED_BAND : BLUE_BAND,
            right ? RED_LIT * 0.85 : BLUE_LIT, right ? RED_LIT : BLUE_LIT2));
        if (right) c = redline(q, d, c);
    }
#endif
    c = bar(p, u_fuelSeg, u_fuel, 0.0, -1.0, c);
    c = bar(p, u_oilSeg, u_oil, 1.0, 1.0, c);
#ifndef SDASH_LIVE
    // the bottom line between the brackets
    if (abs(p.y - u_geo.z) < 3.0 && abs(p.x - u_size.x * 0.5) < u_size.x * 0.5 - outerX(u_geo.z))
        c = over(vec4(mix(BLUE_LINE, RED_LINE, step(u_size.x * 0.5, p.x)) * 0.8, cov(abs(p.y - u_geo.z) - 1.2)), c);
#endif
#ifndef SDASH_BAKE
    // the car-ahead gauge: an upright box filled up to the gap, white (red while closing fast); boost and battery boxes
    c = vbox(p, u_gapRail, u_gapG.x, u_gapG.y > 0.5 ? vec3(1.0, 0.2, 0.22) : vec3(0.96, 0.97, 1.0), c);
    c = vbox(p, u_vbar0, u_vbarV.x, u_vbarC0, c);
    c = vbox(p, u_vbar1, u_vbarV.y, u_vbarC1, c);

    // bottom strip: slanted ends, blue left of the middle, red right, thin dividers
    float sy = p.y - u_strip.y;
    if (sy > -2.0 && sy < u_strip.z + 2.0) {
        float xl = u_strip.x + (u_strip.z - sy) / u_strip.z * u_strip.w;     // left end leans in at the top
        float dx = abs(p.x - u_size.x * 0.5), xe = u_size.x * 0.5 - xl;
        float inside = cov(dx - xe) * cov(-sy) * cov(sy - u_strip.z);
        float f = dx / xe;
        bool left = p.x < u_size.x * 0.5;
        vec3 sc = left ? mix(vec3(0.06, 0.2, 0.62), vec3(0.15, 0.36, 0.92), f) : mix(vec3(0.4, 0.05, 0.1), vec3(0.85, 0.1, 0.16), f);
        if (u_stripFill.x >= 0.0) {
            // filled from the middle out to the value, the rest a dim track
            float val = left ? u_stripFill.x : u_stripFill.y;
            float lit = cov((f - val) * xe) * step(0.001, val);
            if (left && u_stripFill.z > 0.5 && f > 0.9) sc = vec3(0.95, 0.12, 0.16);
            sc = mix(sc * 0.22, sc, lit);
        }
        if (u_stripRoute >= 0.0) {
            // the route: blue from the right end to the progress, the rest a dim track
            float xr = u_size.x - xl, fr = (xr - p.x) / (xr - xl);
            sc = mix(vec3(0.06, 0.2, 0.62), vec3(0.15, 0.42, 0.95), fr);
            sc = mix(sc * 0.2, sc, cov((fr - u_stripRoute) * (xr - xl)) * step(0.001, u_stripRoute));
        }
        c = over(vec4(sc, 0.95 * inside), c);
        float div = cov(abs(mod(p.x - (u_strip.z - sy) * 0.45, 150.0) - 75.0) - 73.8);
        c = over(vec4(0.02, 0.03, 0.08, 0.5 * inside * div), c);
        c = over(vec4(1.0, 1.0, 1.0, 0.25 * inside * cov(abs(sy) - 1.0)), c);
    }
#endif
    gl_FragColor = c;
}
