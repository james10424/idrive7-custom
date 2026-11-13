// The Grand National theme in one cluster-render "effect" layer (GLSL ES 1.00), after a 1987 Buick Grand National's digital-and-needle
// dash: chrome-framed pods left and right (a needle gauge each, pivoting from the pod's inner edge, and lamps under it),
// a centre panel holding a swinging speed needle over a straight row of numbers (the pivot hidden below), two orange
// VFD windows, a fuel needle and an LED rev bar. v_uv (0,0) is the top-left. All the numbers are text widgets over it.
// Big areas stay pure black (the car brightens dark tints); only the frames are grey.
// Three passes from this one file: with RDASH_BAKE only what never changes while driving (frames, marks, the pods'
// zones and ticks, the battery glyph), which the bench bakes with the static labels into the backdrop
// (hud/backdrops/<layout>-<units>.etc2); with RDASH_LIVE that backdrop (u_back) and only what moves over it (the LED
// bars, the redline, the pods' and the gear needles, the lamps, the turn arrows); with neither, everything.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_podL;      // left pod frame x, y, w, h (the right pod is its mirror)
uniform vec4 u_podWin;    // the left pod's gauge window
uniform vec4 u_ctr;       // centre panel frame
uniform vec4 u_win1;      // its upper window (speed)
uniform vec4 u_win2;      // its lower window (fuel, revs)
uniform vec4 u_vfdL;      // the VFD windows
uniform vec4 u_vfdR;
uniform vec4 u_spd;       // speed needle: pivot x, y, the number row's middle y, the mark row's y
uniform vec3 u_spdVirt;   // where the numbers sit: a far pivot's height below the number row, its half sweep (rad); the mph at the scale's start
uniform float u_speedV;   // 0..1 along the scale, below 0 under the first mark (the rest position at 0)
uniform vec4 u_spdK;      // the speed scale: mph at the middle, mph at the end, mph between marks, the amber mark's mph
uniform vec4 u_fuelG;     // fuel: pivot x, y, where the end marks cross the line (+-x from the pivot), the lower band's height
uniform vec3 u_fuelV;     // 0..1, the line the marks split at (y): E, the pump and F sit on it, the row's height above it
uniform vec4 u_podG;      // the left pod's needle: pivot x, y, tick inner r, outer r (right: mirrored)
uniform vec2 u_podV;      // left (battery), right (coolant) 0..1, bottom to top
uniform vec4 u_podZL;     // the left pod's zones as scale fractions: low up to x, ok y..z, high from w (red, green, red)
uniform vec4 u_podZR;     // the right pod's: low (blue) up to x, ok y..z (green), high (red) from w
uniform vec4 u_led;       // LED rev bar x, y, w, h
uniform vec3 u_ledV;      // segments, lit 0..1 (a segment partway lit fades in), the redline 0..1 (a red mark above the labels from there)
uniform vec4 u_led2;      // the boost LED bar x, y, w, h (w 0 = none), all yellow
uniform vec2 u_led2V;     // its segments, lit 0..1
uniform vec4 u_gearN;     // the gear needle: its far pivot x, y (below the P R N D S row), its tip's y, its bottom's y
uniform vec2 u_gearV;     // where it points: the row's point from the pivot (x, y; y < 0)
uniform vec4 u_lampB;     // the parking brake / Auto Hold lamp box (left pod; its mirror in the right pod is the green CRUISE lamp)
uniform vec3 u_arrow;     // the left turn arrow: centre x, y, size (right: mirrored)
uniform vec4 u_lamps;     // left lamp (0 off, 1 red: parking brake, 2 green: Auto Hold), left turn, right turn, cruise on (1) / off (0)
uniform vec2 u_batIcon;   // the battery glyph's centre
#ifdef RDASH_LIVE
uniform sampler2D u_back; // the baked backdrop (ETC2, the layer's size)
#endif

const vec3 CHROME = vec3(0.62, 0.64, 0.68);
const vec3 CHROME2 = vec3(0.32, 0.33, 0.36);
const vec3 TICK = vec3(0.95, 0.95, 0.95);
const vec3 AMBER = vec3(1.0, 0.63, 0.16);
const vec3 NEEDLE = vec3(1.0, 0.8, 0.78);
const vec3 LED_Y = vec3(1.0, 0.86, 0.16);
// the rev bar as the Grand National's: green, every fourth (each 1000 rpm) orange, the redline mark red
const vec3 LED_G = vec3(0.62, 0.86, 0.16);
const vec3 LED_O = vec3(1.0, 0.42, 0.08);
const vec3 LED_GOFF = vec3(0.07, 0.11, 0.02);
const vec3 LED_OOFF = vec3(0.14, 0.05, 0.01);
const vec3 LED_RED = vec3(0.92, 0.08, 0.06);
// the pods' zones as paint printed on the dial, not lit: muted, a little see-through, a darker rim
const vec3 ZONE_RED = vec3(0.6, 0.15, 0.12);
const vec3 ZONE_GREEN = vec3(0.22, 0.47, 0.25);
const vec3 ZONE_BLUE = vec3(0.2, 0.34, 0.62);
const vec3 LED_YOFF = vec3(0.15, 0.12, 0.02);
const vec3 GEAR_RED = vec3(0.9, 0.1, 0.07);
const vec3 LAMP_R = vec3(1.0, 0.27, 0.08);
const vec3 LAMP_OFF = vec3(0.13, 0.04, 0.03);
const vec3 GREEN = vec3(0.2, 0.92, 0.35);
const vec3 LAMP_G = vec3(0.1, 0.62, 0.22);
const vec3 LAMP_GOFF = vec3(0.03, 0.1, 0.05);

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
float rbox(vec2 p, vec4 r, float rad) {
    vec2 c = r.xy + r.zw * 0.5, q = abs(p - c) - r.zw * 0.5 + rad;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
// a chrome frame: a bright outer rim, a dark groove and a softer inner rim, d < 0 inside the box
vec3 frame(float d, vec3 c) {
    c = mix(c, CHROME2, cov(abs(d + 4.0) - 3.0));
    c = mix(c, CHROME, cov(abs(d + 1.2) - 1.2));
    c = mix(c, CHROME * 0.8, cov(abs(d + 7.5) - 0.9));
    return c;
}
// a needle from pivot pv at angle a (0 = straight up, clockwise), between r0 and r1, tapering
vec3 needle(vec2 p, vec2 pv, float a, float r0, float r1, float w0, float w1, vec3 c) {
    vec2 dir = vec2(sin(a), -cos(a)), q = p - pv;
    float al = dot(q, dir), pe = abs(dot(q, vec2(-dir.y, dir.x)));
    float t = clamp((al - r0) / (r1 - r0), 0.0, 1.0), hw = mix(w0, w1, t);
    float d = max(pe - hw, max(r0 - al, al - r1));
    c = mix(c, vec3(0.0), 0.5 * cov(max(abs(dot(q - vec2(2.0, 3.0), vec2(-dir.y, dir.x))) - hw - 2.0, max(r0 - al, al - r1)) / 3.0));
    vec3 col = mix(NEEDLE, NEEDLE * 0.72, smoothstep(0.0, hw, pe));
    return mix(c, col, cov(d));
}
// a mark on a fan round pivot pv at angle a, from r0 to r1, half width hw (a slanted dash)
float mark(vec2 p, vec2 pv, float a, float r0, float r1, float hw) {
    vec2 dir = vec2(sin(a), -cos(a)), q = p - pv;
    float al = dot(q, dir), pe = abs(dot(q, vec2(-dir.y, dir.x)));
    return cov(max(pe - hw, max(r0 - al, al - r1)));
}
// a side pod's dial (sgn -1: the left pod, pointing left; +1 the right): 5 marks over +-50 deg, the long ones at the ends
// and the middle (its needle: podNeedle)
vec3 podDial(vec2 p, vec2 pv, float r0, float r1, float sgn, vec4 z, vec3 c) {
    // the zones: bands on the scale's outer edge as deep as the short marks, under them; low red on the left pod
    // (the battery) and blue on the right (oil), ok green, high red
    vec2 q = p - pv;
    float r = length(q), bw = (r1 - r0) * 0.65;
    if (r > r1 - bw - 1.0 && r < r1 + 1.0) {
        float f = 0.5 + (1.5708 - atan(q.x, -q.y) * sgn) / 1.745, k = 1.745 * r;   // the needle's fraction there
        float bd = max(r1 - bw - r, r - r1), band = 0.85 * cov(bd);
        // the paint's rim: about 1.5 px darker along the band's edges (radial and at the ends)
        float lo = max(-f, f - z.x) * k, ok = max(z.y - f, f - z.z) * k, hi = max(z.w - f, f - 1.0) * k;
        c = mix(c, (sgn < 0.0 ? ZONE_RED : ZONE_BLUE) * mix(1.0, 0.78, smoothstep(-2.5, -1.0, max(bd, lo))), band * cov(lo));
        c = mix(c, ZONE_GREEN * mix(1.0, 0.78, smoothstep(-2.5, -1.0, max(bd, ok))), band * cov(ok));
        c = mix(c, ZONE_RED * mix(1.0, 0.78, smoothstep(-2.5, -1.0, max(bd, hi))), band * cov(hi));
    }
    for (int i = 0; i < 5; i++) {
        float f = float(i) / 4.0, a = sgn * (1.5708 + (f - 0.5) * 1.745);
        float lg = mod(float(i), 2.0) < 0.5 ? 1.0 : 0.0;
        c = mix(c, TICK, mark(p, pv, a, r0 + (1.0 - lg) * (r1 - r0) * 0.35, r1, 3.2));
    }
    return c;
}
// its needle at v (0..1, bottom to top)
vec3 podNeedle(vec2 p, vec2 pv, float r0, float r1, float sgn, float v, vec3 c) {
    float a = sgn * (1.5708 - (clamp(v, -0.03, 1.03) - 0.5) * 1.745);
    return needle(p, pv, a, r0 * 0.25, r1 + 14.0, 4.5, 2.5, c);
}

void main() {
    vec2 p = v_uv * u_size;
#ifdef NEEDLE_LAYER
    // the needles alone, transparent round them (straight alpha): a layer of its own over the text sheets, so the
    // speed needle sweeps over the odometer under the 55 and the fuel needle over PREMIUM FUEL (shaders.js
    // rdashNeedle; the widget's box spans the centre panel's two windows)
    {
        vec2 sp = u_spd.xy;
        float numY = u_spd.z, Hv = u_spdVirt.x, S = u_spdVirt.y;
        // it points at the speed's place on the number row; one fixed length: straight up it reaches slightly above the
        // numbers, so toward the ends it stops short of the row. u_speedV < 0: below the first mark, down to the rest
        // position under the row at 0
        float xs = sp.x + Hv * tan(-S + 2.0 * S * clamp(u_speedV, -0.5, 1.0));
        float a = atan(xs - sp.x, sp.y - numY), r0 = 0.0, r1 = sp.y - numY + 40.0, w0 = 5.5, w1 = 3.0;
        vec2 dir = vec2(sin(a), -cos(a)), q = p - sp, n = vec2(-dir.y, dir.x);
        float al = dot(q, dir), pe = abs(dot(q, n));
        float hw = mix(w0, w1, clamp((al - r0) / (r1 - r0), 0.0, 1.0));
        float d = max(pe - hw, max(r0 - al, al - r1));
        float sh = 0.5 * cov(max(abs(dot(q - vec2(2.0, 3.0), n)) - hw - 2.0, max(r0 - al, al - r1)) / 3.0);
        float na = cov(d), inWin = rbox(p, u_win1, 8.0) < 0.0 ? 1.0 : 0.0;
        vec3 col = mix(NEEDLE, NEEDLE * 0.72, smoothstep(0.0, hw, pe));
        if (rbox(p, u_win2, 8.0) < 0.0) {
            // the fuel needle, as needle() draws it in the main pass, its shadow included
            // it points along the marks' spacing (where it crosses the line, linear in the fuel), one length: at half a
            // tank its tip is the top of the pump (u_fuelV.y: the line, .z: the row over it)
            float fdepth = u_fuelG.y - u_fuelV.y;
            vec2 fdir = normalize(vec2((clamp(u_fuelV.x, -0.03, 1.03) * 2.0 - 1.0) * u_fuelG.z, -fdepth));
            vec2 fq = p - u_fuelG.xy, fn = vec2(-fdir.y, fdir.x);
            float fr0 = 0.0, fr1 = fdepth + 4.0 + u_fuelV.z, fal = dot(fq, fdir), fpe = abs(dot(fq, fn));
            float fhw = mix(4.5, 2.5, clamp((fal - fr0) / (fr1 - fr0), 0.0, 1.0));
            na = cov(max(fpe - fhw, max(fr0 - fal, fal - fr1)));
            sh = 0.5 * cov(max(abs(dot(fq - vec2(2.0, 3.0), fn)) - fhw - 2.0, max(fr0 - fal, fal - fr1)) / 3.0);
            col = mix(NEEDLE, NEEDLE * 0.72, smoothstep(0.0, fhw, fpe));
            inWin = 1.0;
        }
        float aa = (na + sh * (1.0 - na)) * inWin;
        gl_FragColor = aa > 0.0 ? vec4(col * na / max(na + sh * (1.0 - na), 1e-4), aa) : vec4(0.0);
        return;
    }
#endif
    float W = u_size.x;
    vec4 winR = vec4(W - u_podWin.x - u_podWin.z, u_podWin.y, u_podWin.z, u_podWin.w);
    vec2 pvL = u_podG.xy, pvR = vec2(W - u_podG.x, u_podG.y);
#ifdef RDASH_LIVE
    vec3 c = texture2D(u_back, v_uv).rgb;
#else
    vec3 c = vec3(0.0);
    vec4 podR = vec4(W - u_podL.x - u_podL.z, u_podL.y, u_podL.z, u_podL.w);

    // frames
    c = frame(rbox(p, u_podL, 14.0), c);
    c = frame(rbox(p, podR, 14.0), c);
    c = frame(rbox(p, u_ctr, 12.0), c);
    c = mix(c, CHROME2, cov(abs(rbox(p, u_podWin, 8.0)) - 1.0));
    c = mix(c, CHROME2, cov(abs(rbox(p, winR, 8.0)) - 1.0));
    c = mix(c, CHROME2, cov(abs(rbox(p, u_win1, 8.0)) - 1.0));
    c = mix(c, CHROME2, cov(abs(rbox(p, u_win2, 8.0)) - 1.0));
    if (u_vfdL.z > 0.0) c = mix(c, CHROME2 * 0.9, cov(abs(rbox(p, u_vfdL, 7.0)) - 1.0));
    if (u_vfdR.z > 0.0) c = mix(c, CHROME2 * 0.9, cov(abs(rbox(p, u_vfdR, 7.0)) - 1.0));

    // speed: the numbers sit along a straight row where a far "virtual" pivot (u_spdVirt: its height below the number row,
    // half sweep) would put them, so they stay readable; the real needle pivots at u_spd.xy (on the frame under the window) and
    // turns to point at them, and each mark lies on the line from that pivot to its number
    vec2 sp = u_spd.xy;
    float numY = u_spd.z, tickY = u_spd.w, Hv = u_spdVirt.x, S = u_spdVirt.y;
    if (rbox(p, u_win1, 8.0) < 0.0) {
        // the scale runs u_spdVirt.z..u_spdK.y mph, u_spdK.x at the middle (each half linear: 5..85 with 45 there, so the
        // 45's mark points straight at the pivot); a mark every u_spdK.z mph, the long ones on the labelled speeds (5, 15,
        // 25 ...: odd multiples of the step)
        float xr = sp.x + (p.x - sp.x) * (sp.y - numY) / max(sp.y - p.y, 1.0);   // where this pixel's ray meets the number row
        float f = (atan((xr - sp.x) / Hv) + S) / (2.0 * S);
        float lo = u_spdVirt.z;
        float mph = f <= 0.5 ? lo + 2.0 * f * (u_spdK.x - lo) : u_spdK.x + (f - 0.5) * 2.0 * (u_spdK.y - u_spdK.x);
        float m = floor(mph / u_spdK.z + 0.5) * u_spdK.z;
        if (m >= u_spdK.z && m <= u_spdK.y) {
            float mf = m <= u_spdK.x ? 0.5 * (m - lo) / (u_spdK.x - lo) : 0.5 + 0.5 * (m - u_spdK.x) / (u_spdK.y - u_spdK.x);
            float xm = sp.x + Hv * tan(-S + 2.0 * S * mf), major = mod(m / u_spdK.z, 2.0) > 0.5 ? 1.0 : 0.0;
            float a = atan(xm - sp.x, sp.y - numY);
            float y0 = tickY - mix(8.0, 13.0, major), y1 = tickY + mix(3.0, 9.0, major);
            vec2 dir = vec2(sin(a), -cos(a));
            float pe = abs(dot(p - sp, vec2(-dir.y, dir.x)));
            float d = max(pe - mix(2.0, 4.5, major), max(y0 - p.y, p.y - y1));
            c = mix(c, m == u_spdK.w ? AMBER : TICK, cov(d));
        }
        // the speed needle is its own layer over the text (NEEDLE_LAYER below), so it sweeps over the PRND row
    }

    // fuel, as the Grand National's: 5 marks on rays from a pivot just under PREMIUM FUEL, crossing a horizontal line
    // (u_fuelV.y) evenly spaced out to +-u_fuelG.z, each cut by two bands along it: under the line every mark's lower part
    // (u_fuelG.w tall), over it a row as tall as E, the pump and F (u_fuelV.z), where only the two marks between show (E,
    // the pump and F, text and icon widgets, stand in the others' place). Its needle is on the needle layer
    vec2 fp = u_fuelG.xy;
    if (rbox(p, u_win2, 8.0) < 0.0) {
        float ly = u_fuelV.y, depth = fp.y - ly;
        float below = cov(ly + 4.0 - p.y) * cov(p.y - ly - 4.0 - u_fuelG.w);
        float above = cov(p.y - ly + 4.0) * cov(ly - 4.0 - u_fuelV.z - p.y);
        for (int i = 0; i < 5; i++) {
            float a = atan((float(i) / 2.0 - 1.0) * u_fuelG.z, depth);
            // the two marks between (no E, pump or F over them) thinner, as the Grand National's
            bool between = i == 1 || i == 3;
            float part = between ? max(below, above) : below;
            c = mix(c, TICK, mark(p, fp, a, 0.0, depth + 80.0, between ? 1.8 : 3.0) * part);
        }
    }

    // the side pods' dials (the pivots sit behind each pod's inner edge)
    if (rbox(p, u_podWin, 8.0) < 0.0) c = podDial(p, pvL, u_podG.z, u_podG.w, -1.0, u_podZL, c);
    if (rbox(p, winR, 8.0) < 0.0) c = podDial(p, pvR, u_podG.z, u_podG.w, 1.0, u_podZR, c);

    // battery glyph: a box with two terminals
    vec2 bq = p - u_batIcon;
    float bat = abs(rbox(bq, vec4(-14.0, -8.0, 28.0, 17.0), 2.0)) - 1.3;
    bat = min(bat, rbox(bq, vec4(-10.0, -12.0, 5.0, 4.0), 0.5));
    bat = min(bat, rbox(bq, vec4(5.0, -12.0, 5.0, 4.0), 0.5));
    c = mix(c, TICK, cov(bat));
#endif
#ifdef RDASH_BAKE
    gl_FragColor = vec4(c, 1.0);
#else
    // what moves: the pods' needles
    if (rbox(p, u_podWin, 8.0) < 0.0) c = podNeedle(p, pvL, u_podG.z, u_podG.w, -1.0, u_podV.x, c);
    if (rbox(p, winR, 8.0) < 0.0) c = podNeedle(p, pvR, u_podG.z, u_podG.w, 1.0, u_podV.y, c);

    // LED rev bar: segments with a gap, lit up to the revs, green with every fourth orange
    if (p.x >= u_led.x && p.x < u_led.x + u_led.z && p.y >= u_led.y && p.y < u_led.y + u_led.w) {
        float n = u_ledV.x, pitch = u_led.z / n, i = floor((p.x - u_led.x) / pitch);
        float lx = p.x - u_led.x - i * pitch;
        float d = rbox(vec2(lx, p.y), vec4(1.0, u_led.y, pitch - 3.0, u_led.w), 1.0);
        // lit up to the level; the segment it is partway into fades in by how far
        float lit = clamp(u_ledV.y * n - i, 0.0, 1.0);
        bool o = mod(i, 4.0) < 0.5;
        vec3 col = mix(o ? LED_OOFF : LED_GOFF, o ? LED_O : LED_G, lit);
        c = mix(c, col, cov(d));
    }
    // the redline: a red mark from it to the end of the last label ("70", centred half a segment past the bar's end,
    // 24 px wide: 18 px past the end), level with "RPM X 100" above the labels
    if (u_ledV.z < 0.999 && abs(p.y - u_led.y + 46.0) < 6.0)
        c = mix(c, LED_RED, cov(rbox(p, vec4(u_led.x + u_led.z * u_ledV.z, u_led.y - 50.0,
            u_led.z * (1.0 - u_ledV.z) + 0.5 * u_led.z / u_ledV.x + 12.0, 8.0), 1.0)));

    // boost LED bar: the same segments, yellow
    if (u_led2.z > 0.0 && p.x >= u_led2.x && p.x < u_led2.x + u_led2.z && p.y >= u_led2.y && p.y < u_led2.y + u_led2.w) {
        float n = u_led2V.x, pitch = u_led2.z / n, i = floor((p.x - u_led2.x) / pitch);
        float lx = p.x - u_led2.x - i * pitch;
        float d = rbox(vec2(lx, p.y), vec4(1.5, u_led2.y, pitch - 4.5, u_led2.w), 1.5);
        c = mix(c, mix(LED_YOFF, LED_Y, clamp(u_led2V.y * n - i, 0.0, 1.0)), cov(d));
    }

    // the gear needle, red, behind the P R N D S row (the see-through letters are over this layer): on the ray from a far
    // pivot below the row to the point it points at, from the pod's bottom up to one length (the letters' top straight up)
    if (p.y > u_gearN.z - 3.0 && p.y < u_gearN.w + 3.0) {
        vec2 gd = normalize(u_gearV), gq = p - u_gearN.xy;
        float gal = dot(gq, gd), gpe = abs(dot(gq, vec2(-gd.y, gd.x)));
        float gr0 = (u_gearN.w - u_gearN.y) / gd.y, gr1 = u_gearN.y - u_gearN.z;
        float ghw = mix(2.4, 1.3, clamp((gal - gr0) / (gr1 - gr0), 0.0, 1.0));
        c = mix(c, mix(GEAR_RED, GEAR_RED * 0.7, smoothstep(0.0, ghw, gpe)), cov(max(gpe - ghw, max(gr0 - gal, gal - gr1))));
    }

    // lamps: PARK BRAKE (left, red) or AUTO HOLD (left, green), CRUISE (right, green), the turn arrows
    vec4 lampR = vec4(W - u_lampB.x - u_lampB.z, u_lampB.yzw);
    c = mix(c, u_lamps.x > 1.5 ? LAMP_G : u_lamps.x > 0.5 ? LAMP_R : LAMP_OFF, cov(rbox(p, u_lampB, 3.0)));
    c = mix(c, mix(LAMP_GOFF, LAMP_G, u_lamps.w), cov(rbox(p, lampR, 3.0)));
    for (int s = 0; s < 2; s++) {
        if (u_arrow.z <= 0.0) break;   // no turn arrows (size 0)
        float on = s == 0 ? u_lamps.y : u_lamps.z;
        vec2 ac = s == 0 ? u_arrow.xy : vec2(W - u_arrow.x, u_arrow.y);
        vec2 q = (p - ac) / u_arrow.z;
        if (s == 0) q.x = -q.x;
        // shaft and head of an arrow pointing right (left one mirrored)
        float d = max(abs(q.y) - 0.16, abs(q.x + 0.2) - 0.35);
        float hd = max(q.x - 0.55, max(abs(q.y) - (0.55 - q.x) * 0.9, -q.x - 0.05));
        d = min(d, hd) * u_arrow.z;
        c = mix(c, mix(vec3(0.03, 0.09, 0.04), GREEN, on), cov(d));
    }
    gl_FragColor = vec4(c, 1.0);
#endif
}
