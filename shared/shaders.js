'use strict';
/**
 * The HUD's GLSL ES 1.00 fragment shaders for cluster-render "effect" layers, drawn on the
 * car's GPU. Kept as JS strings because the kit's build ships an app's top-level .js files
 * as they are (a data folder becomes a JSON-only pack). hud.js sends the uniforms.
 */
const SHIFTBAR = `// Segmented shift bar for a cluster-render "effect" layer (GLSL ES 1.00).
// v_uv is 0..1 across the layer, (0,0) at the top-left as on the car. Uniforms come from hud.js:
//   u_value   0..1, how much of the bar is lit (rpm / bar max)
//   u_size    layer size in px (w, h), for round corners and gaps in pixels
//   u_segs    segment count
//   u_low, u_mid, u_high   zone colours (rgb 0..1)
//   u_midAt, u_highAt      where the mid and high zones start (0..1 of the bar)
//   u_track   unlit segment colour (rgba, straight alpha)
//   u_flash   1 = at the redline: every lit segment shows the high colour
// Output is straight alpha. Whether cluster-render blends effect layers as
// straight or premultiplied alpha is not confirmed yet: check the edges on the car.
precision mediump float;
varying vec2 v_uv;
uniform float u_value;
uniform vec2 u_size;
uniform float u_segs;
uniform vec3 u_low;
uniform vec3 u_mid;
uniform vec3 u_high;
uniform float u_midAt;
uniform float u_highAt;
uniform vec4 u_track;
uniform float u_flash;

void main() {
    float gapPx = 3.0;
    float slot = u_size.x / u_segs;                 // px per segment incl. gap
    float px = v_uv.x * u_size.x;
    float idx = floor(px / slot);
    float inSeg = px - idx * slot;                  // px into this slot
    float segW = slot - gapPx;
    float py = v_uv.y * u_size.y;           // px from the top

    // rounded-rect coverage for this segment, radius 2px, 1px soft edge
    vec2 hs = vec2(segW, u_size.y) * 0.5;
    vec2 p = vec2(inSeg, py) - hs;
    vec2 q = abs(p) - (hs - vec2(2.0));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 2.0;
    float cover = clamp(0.5 - d, 0.0, 1.0);
    if (inSeg > segW) cover = 0.0;
    if (cover <= 0.0) { gl_FragColor = vec4(0.0); return; }

    float pos = (idx + 0.5) / u_segs;               // segment centre, 0..1
    bool lit = pos <= u_value;
    vec3 c = pos >= u_highAt ? u_high : (pos >= u_midAt ? u_mid : u_low);
    if (u_flash > 0.5) c = u_high;
    gl_FragColor = lit ? vec4(c, cover) : vec4(u_track.rgb, u_track.a * cover);
}
`;

const ARC = `// Thin open arc gauge for a cluster-render "effect" layer (GLSL ES 1.00).
// u_start / u_sweep (radians, clockwise from 12 o'clock; a negative sweep runs anticlockwise), round
// ends, filled from the start. hud.js default: 270 degrees from the lower left, the gap at the bottom.
// Uniforms from hud.js:
//   u_value  0..1 of the sweep
//   u_size   layer size in px (w, h)
//   u_color  lit arc (rgb 0..1)
//   u_track  unlit arc (rgba, straight alpha)
//   u_width  stroke width in px
// Output is straight alpha (same open question as the shift bar shader above).
precision mediump float;
varying vec2 v_uv;
uniform float u_value;
uniform vec2 u_size;
uniform vec3 u_color;
uniform vec4 u_track;
uniform float u_width;
uniform float u_start;
uniform float u_sweep;

const float PI = 3.14159265359;

// distance from point p (centred, px) to the arc from angle a0 sweeping s, radius r
float arcDist(vec2 p, float r, float a0, float s) {
    float a = atan(p.x, p.y);           // clockwise from 12 o'clock, -PI..PI
    float rel = mod(a - a0 + 4.0 * PI, 2.0 * PI);
    if (rel <= s) return abs(length(p) - r);
    vec2 e0 = r * vec2(sin(a0), cos(a0));
    vec2 e1 = r * vec2(sin(a0 + s), cos(a0 + s));
    return min(length(p - e0), length(p - e1));   // round end caps
}

void main() {
    vec2 p = vec2(v_uv.x - 0.5, 0.5 - v_uv.y) * u_size;   // px from centre, +y up (v_uv is top-left)
    float start = u_start, sweep = u_sweep;
    if (sweep < 0.0) { p.x = -p.x; start = -start; sweep = -sweep; }   // anticlockwise = mirrored clockwise
    float r = min(u_size.x, u_size.y) * 0.5 - u_width * 0.5 - 1.0;
    float hw = u_width * 0.5;
    float dTrack = arcDist(p, r, start, sweep) - hw;
    float lit = clamp(u_value, 0.0, 1.0) * sweep;
    float dLit = lit > 0.001 ? arcDist(p, r, start, lit) - hw : 1e5;
    float cLit = clamp(0.5 - dLit, 0.0, 1.0);
    float cTrack = clamp(0.5 - dTrack, 0.0, 1.0);
    if (cLit > 0.0) gl_FragColor = vec4(u_color, cLit);
    else gl_FragColor = vec4(u_track.rgb, u_track.a * cTrack);
}
`;

const REVBAR = `// G20 Live Cockpit style rev bar for a cluster-render "effect" layer (GLSL ES 1.00), after
// cauliflowermossgrape's Redline app (MIT). From the top of the layer: u_top px for the shift-point and
// redline marks, then the bar (u_barH px, slanted: its top edge is u_slant px right of its bottom
// edge), then the scale ticks. The bar fills left to right in 500 rpm segments; each lit segment
// takes the ramp colour of its position up to the shift point (u_from -> u_to), all u_hot from the
// shift point on. Unlit: u_track, and u_hot faint past the redline. A white needle leads the fill;
// a thin slanted line holds the peak. Uniforms (rpm values are rpm, not 0..1):
//   u_size, u_top, u_barH, u_slant   px
//   u_max, u_value, u_shift, u_red, u_peak   rpm
//   u_from, u_to, u_hot   rgb 0..1;  u_track, u_tick, u_fg   rgba (straight alpha)
//   u_shiftNow   1 = at or past the shift point
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_top;
uniform float u_barH;
uniform float u_slant;
uniform float u_max;
uniform float u_value;
uniform float u_shift;
uniform float u_red;
uniform float u_peak;
uniform vec3 u_from;
uniform vec3 u_to;
uniform vec3 u_hot;
uniform vec4 u_track;
uniform vec4 u_tick;
uniform vec4 u_fg;
uniform float u_shiftNow;

vec4 over(vec4 top, vec4 under) {           // straight-alpha "top over under"
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}

void main() {
    float px = v_uv.x * u_size.x;
    float py = v_uv.y * u_size.y;   // px from the top
    float bw = u_size.x - u_slant;            // bar length along the bottom edge
    float perRpm = bw / u_max;
    vec4 c = vec4(0.0);

    // marks above the bar: shift point (amber) and redline (red), at the bar's top edge
    if (py < u_top - 2.0) {
        float ds = abs(px - (u_shift * perRpm + u_slant));
        float dr = abs(px - (u_red * perRpm + u_slant));
        if (ds < 2.0) c = vec4(1.0, 0.76, 0.1, clamp(2.0 - ds, 0.0, 1.0));
        if (dr < 2.0) c = vec4(u_hot, clamp(2.0 - dr, 0.0, 1.0));
        gl_FragColor = c; return;
    }

    float by = py - u_top;                    // px down from the bar's top edge
    if (by <= u_barH) {
        float off = u_slant * (u_barH - by) / u_barH;
        float s = px - off;                   // px along the bar at this height
        float rpm = s / perRpm;
        float inside = clamp(s + 0.5, 0.0, 1.0) * clamp(bw - s + 0.5, 0.0, 1.0)
            * clamp(by + 0.5, 0.0, 1.0) * clamp(u_barH - by + 0.5, 0.0, 1.0);
        // slanted 3 px gap every 500 rpm
        float seg = floor(rpm / 500.0);
        float dGap = abs(s - floor(rpm / 500.0 + 0.5) * 500.0 * perRpm);
        float gap = rpm > 250.0 && rpm < u_max - 250.0 ? clamp(dGap - 1.0, 0.0, 1.0) : 1.0;
        vec4 bar;
        if (rpm <= u_value) {
            float f = clamp((seg * 500.0 + 250.0) / u_shift, 0.0, 1.0);
            vec3 col = u_shiftNow > 0.5 ? u_hot : mix(u_from, u_to, f);
            bar = vec4(col, 1.0);
        } else if (rpm >= u_red) bar = vec4(u_hot, 0.3);
        else bar = u_track;
        c = vec4(bar.rgb, bar.a * inside * gap);
        // peak: a thin slanted line where the rpm last peaked (only above the current rpm)
        if (u_peak > u_value + 60.0) {
            float dp = abs(s - u_peak * perRpm);
            vec3 pc = u_peak >= u_shift ? u_hot : mix(u_from, u_to, clamp(u_peak / u_shift, 0.0, 1.0));
            c = over(vec4(pc, clamp(1.5 - dp, 0.0, 1.0) * inside), c);
        }
        // needle: the bright leading edge of the fill
        if (u_value > 50.0) {
            float dn = abs(s - min(u_value, u_max) * perRpm);
            c = over(vec4(1.0, 1.0, 1.0, clamp(2.5 - dn, 0.0, 1.0) * clamp(by + 2.5, 0.0, 1.0) * clamp(u_barH - by + 2.5, 0.0, 1.0)), c);
        }
        gl_FragColor = c; return;
    }

    // scale ticks under the bar: every 500 rpm, longer every 1000, red from the redline
    float ty = by - u_barH - 4.0;
    if (ty >= 0.0) {
        float rpm = px / perRpm;
        float k = floor(rpm / 500.0 + 0.5);
        float d = abs(px - k * 500.0 * perRpm);
        bool major = mod(k, 2.0) < 0.5;
        float len = major ? 10.0 : 5.0;
        float hw = major ? 1.25 : 0.75;
        float a = clamp(hw + 0.5 - d, 0.0, 1.0) * (ty <= len ? 1.0 : 0.0);
        vec4 tc = k * 500.0 >= u_red ? vec4(u_hot, 1.0) : (major ? u_fg : u_tick);
        c = vec4(tc.rgb, tc.a * a);
    }
    gl_FragColor = c;
}
`;

const LIGHTS = `// Shift lights for a cluster-render "effect" layer (GLSL ES 1.00), after cauliflowermossgrape's Redline
// app (MIT): u_n rounded lights in a row, green -> yellow -> red from left to right. u_lit of them are
// on (they fill from a start rpm up to the shift point); u_strobe 1 = at the shift point: all red.
// The last u_tail lights are blue instead (the GT3 dash look; 0 = none). u_round 1 = round lights.
//   u_size px, u_n count, u_lit count (0..u_n), u_tail count, u_strobe 0/1, u_green/u_yellow/u_red/u_blue rgb,
//   u_off (alpha when off)
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_n;
uniform float u_lit;
uniform float u_tail;
uniform float u_round;
uniform float u_strobe;
uniform vec3 u_green;
uniform vec3 u_yellow;
uniform vec3 u_red;
uniform vec3 u_blue;
uniform float u_off;

void main() {
    float gapPx = 6.0;
    float slot = (u_size.x + gapPx) / u_n;
    float px = v_uv.x * u_size.x;
    float py = v_uv.y * u_size.y;
    float idx = floor(px / slot);
    float inSeg = px - idx * slot;
    float segW = slot - gapPx;
    if (inSeg > segW || idx >= u_n) { gl_FragColor = vec4(0.0); return; }
    vec2 hs = vec2(segW, u_size.y) * 0.5;
    vec2 p = vec2(inSeg, py) - hs;
    float r = u_round > 0.5 ? min(hs.x, hs.y) : min(4.0, hs.y);
    if (u_round > 0.5) hs = vec2(r);
    p = vec2(inSeg, py) - vec2(segW, u_size.y) * 0.5;
    vec2 q = abs(p) - (hs - vec2(r));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    float cover = clamp(0.5 - d, 0.0, 1.0);
    float nMain = max(1.0, u_n - u_tail);
    float f = idx / max(1.0, nMain - 1.0);
    vec3 col = idx >= nMain ? u_blue : (f < 0.42 ? u_green : (f < 0.75 ? u_yellow : u_red));
    bool on = idx < u_lit;
    if (u_strobe > 0.5) { col = u_red; on = true; }
    gl_FragColor = vec4(col, cover * (on ? 1.0 : u_off));
}
`;

const FILL = `// Solid fill for a cluster-render "effect" layer (GLSL ES 1.00): u_color everywhere, except a
// see-through rounded hole u_hole (x, y, w, h px from the layer's top left; w = 0: no hole), radius u_holeR.
// On the cluster, an opaque fill hides BMW's own gauges under it; the hole lets the map window show.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_color;
uniform vec4 u_hole;
uniform float u_holeR;

void main() {
    vec2 p = vec2(v_uv.x * u_size.x, v_uv.y * u_size.y);
    float a = u_color.a;
    if (u_hole.z > 0.0) {
        vec2 hs = u_hole.zw * 0.5;
        vec2 q = abs(p - (u_hole.xy + hs)) - (hs - vec2(u_holeR));
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_holeR;
        a *= clamp(d + 0.5, 0.0, 1.0);
    }
    gl_FragColor = vec4(u_color.rgb, a);
}
`;

const BOX = `// Framed box for a cluster-render "effect" layer (GLSL ES 1.00), the race-dash readout box: a rounded
// frame u_border px wide in u_line, filled u_fill, with a header strip u_headH px tall in u_head across the
// top (0 = none). Colours rgba, straight alpha. u_size, u_border, u_headH, u_radius in px.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_fill;
uniform vec4 u_line;
uniform vec4 u_head;
uniform float u_headH;
uniform float u_border;
uniform float u_radius;

void main() {
    vec2 p = vec2(v_uv.x * u_size.x, v_uv.y * u_size.y);
    vec2 hs = u_size * 0.5;
    vec2 q = abs(p - hs) - (hs - vec2(u_radius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;   // < 0 inside
    float outer = clamp(0.5 - d, 0.0, 1.0);
    if (outer <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec4 c = p.y < u_headH ? u_head : u_fill;
    float edge = clamp(d + u_border + 0.5, 0.0, 1.0);                       // 1 within the frame
    vec4 col = mix(c, u_line, edge);
    gl_FragColor = vec4(col.rgb, col.a * outer);
}
`;

const BOXES = `// The GT3 race dash's frame in one cluster-render "effect" layer (GLSL ES 1.00): the background u_bg over the
// whole layer, a see-through rounded hole for BMW's map (u_hole x, y, w, h in layer px, already inset; w 0 = none;
// corner radius u_holeR) and up to 12 framed readout boxes from the layout: each a rounded frame in u_line, filled
// u_fill, with a header strip across its top in u_head (or u_accent). Array uniforms (sent with type vec4):
//   u_box[i]       x, y, w, h in layer px
//   u_boxStyle[i]  header height px, border px, corner radius px, header kind (0 u_head, 1 u_accent)
//   u_n            boxes in use (the rest are skipped). Boxes must not overlap each other or the hole.
// Colours rgba, straight alpha. The loop bound is constant and the arrays are indexed by the loop counter only,
// as GLSL ES 1.00 requires.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_bg;
uniform vec4 u_hole;
uniform float u_holeR;
uniform float u_n;
uniform vec4 u_box[12];
uniform vec4 u_boxStyle[12];
uniform vec4 u_fill;
uniform vec4 u_line;
uniform vec4 u_head;
uniform vec4 u_accent;

// signed distance to the rounded rect r (x, y, w, h), radius rad; < 0 inside
float sdBox(vec2 p, vec4 r, float rad) {
    vec2 hs = r.zw * 0.5;
    vec2 q = abs(p - (r.xy + hs)) - (hs - vec2(rad));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
vec4 over(vec4 top, vec4 under) {           // straight-alpha "top over under"
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}

void main() {
    vec2 p = v_uv * u_size;
    vec4 c = u_bg;
    if (u_hole.z > 0.0) c.a *= clamp(sdBox(p, u_hole, u_holeR) + 0.5, 0.0, 1.0);
    for (int i = 0; i < 12; i++) {
        if (float(i) >= u_n) break;
        vec4 b = u_box[i];
        vec4 s = u_boxStyle[i];
        if (p.x < b.x - 1.0 || p.x > b.x + b.z + 1.0 || p.y < b.y - 1.0 || p.y > b.y + b.w + 1.0) continue;
        float d = sdBox(p, b, s.z);
        float outer = clamp(0.5 - d, 0.0, 1.0);
        if (outer <= 0.0) continue;
        vec4 inner = p.y < b.y + s.x ? (s.w > 0.5 ? u_accent : u_head) : u_fill;
        float edge = clamp(d + s.y + 0.5, 0.0, 1.0);               // 1 within the frame
        vec4 col = mix(inner, u_line, edge);
        c = over(vec4(col.rgb, col.a * outer), c);
    }
    gl_FragColor = c;
}
`;

const GRID = `// Calibration grid for a cluster-render "effect" layer (GLSL ES 1.00): a line every u_step px, a brighter
// one every u_major steps, a frame round the edge. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_step;
uniform float u_major;
uniform vec4 u_minor;
uniform vec4 u_majorC;

void main() {
    vec2 p = v_uv * u_size;
    vec2 m = mod(p, u_step);
    vec2 big = mod(p, u_step * u_major);
    bool edge = p.x < 2.0 || p.y < 2.0 || p.x > u_size.x - 2.0 || p.y > u_size.y - 2.0;
    if (edge || big.x < 2.0 || big.y < 2.0) gl_FragColor = u_majorC;
    else if (m.x < 1.0 || m.y < 1.0) gl_FragColor = u_minor;
    else gl_FragColor = vec4(0.0);
}
`;

const SEGBAR = `// Segmented level bar for a cluster-render "effect" layer (GLSL ES 1.00): u_segs segments, the first
// u_lit of them lit (brightening left to right), each slanted u_slant px. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_segs;
uniform float u_lit;
uniform vec4 u_on;
uniform vec4 u_offC;
uniform float u_slant;
uniform float u_gap;      // px between segments (8 when not given)
uniform float u_hotSeg;   // a segment drawn in u_hotC instead (the throttle's last one in kickdown); -1 none
uniform vec4 u_hotC;

void main() {
    vec2 p = v_uv * u_size;
    float x = p.x - u_slant * (1.0 - v_uv.y);
    float gap = u_gap > 0.0 ? u_gap : 8.0;
    float slot = (u_size.x - u_slant + gap) / u_segs;
    float i = floor(x / slot);
    float fx = x - i * slot;
    float a = clamp(fx + 0.5, 0.0, 1.0) * clamp(slot - gap - fx + 0.5, 0.0, 1.0);
    if (i < 0.0 || i >= u_segs || a <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec4 on = abs(i - u_hotSeg) < 0.5 ? u_hotC : u_on;
    vec4 col = i < u_lit ? vec4(on.rgb * mix(0.72, 1.0, fx / (slot - gap)), on.a) : u_offC;
    gl_FragColor = vec4(col.rgb, col.a * a);
}
`;

const MDASH = `// The M theme's whole backdrop in one cluster-render "effect" layer (GLSL ES 1.00), traced off a photo of a current
// M8's cluster (design/photos/ref-m8-cluster.png, warped to 1920x720): black, with a near-black card either side whose
// inner edge follows the rev blade, whose top edge is the photo's curve and whose bottom outer corner is a big round;
// the centre line with its bright end caps, the tyre block's car glyph and dividers (the eight values are text widgets),
// the two side dials over the cards (the photo's thin glass bracket, hatched bezel, red streaks), the tricolour mark
// and the four setup level bars (slanted segments, the one at the level red, the rest grey, as the M8 draws them).
// Positions in target px from the layout (hud.js). v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_card;      // left card: outer edge x, bottom y, bottom-outer corner radius, top-outer corner rounding (the right card is its mirror)
uniform vec3 u_cardCutR;  // the right card's lower outer corner, cut back on a circle (mirrored frame: cx, cy, r; r 0 = none): the M8's
                          // right card is cut further than its left one, so the oil dial's numbers sit on black
uniform vec3 u_cardTop;   // the left card's top edge, y = a x^2 + b x + c (traced off the M8 photo)
uniform float u_cardFill; // the card's grey level 0..1 (0 = black, outline only)
uniform vec4 u_blade;     // the left rev blade's outer edge: x at the bend, y of the bend, x per y px above / below it
uniform vec2 u_bladeB;    // the bend's roundness px, the card's gap from the blade px
uniform vec4 u_line;      // centre line x0, y, x1, cap length
uniform vec3 u_tyre;      // the tyre block's car glyph: centre x, y, scale (0 = none)
uniform vec4 u_gaugeL;    // left gauge centre x, y, radius, value 0..1
uniform vec4 u_gaugeR;    // right gauge
uniform vec3 u_mark;      // tricolour mark x, y, scale (0 = none)
uniform vec3 u_red;
uniform vec4 u_seg0;      // setup level bars x, y, w, h (a height of 0: none)
uniform vec4 u_seg1;
uniform vec4 u_seg2;
uniform vec4 u_seg3;
uniform vec4 u_segLit;    // the level per bar (1-based; 0 = none lit)
uniform vec4 u_segMax;    // segments per bar
uniform float u_segSlant; // px each segment leans

const float PI = 3.14159265;

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }

float sdRoundBox(vec2 p, vec4 r, float rad) {
    vec2 c = r.xy + r.zw * 0.5;
    vec2 q = abs(p - c) - r.zw * 0.5 + rad;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
float angOf(vec2 d) { float a = atan(d.x, -d.y); return a < 0.0 ? a + 2.0 * PI : a; }
// the left blade's outer edge x at y (mtach's curve)
float bladeX(float y) {
    float dy = y - u_blade.y;
    float k = dy < 0.0 ? u_blade.z : u_blade.w;
    return u_blade.x + k * (sqrt(dy * dy + u_bladeB.x * u_bladeB.x) - u_bladeB.x);
}
// smooth intersection of two signed distances (rounds the corner where they meet)
float smax(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }
// the left card as the M8 draws it: a wedge whose top edge is the traced curve, outer edge at u_card.x, bottom at
// u_card.y, inner side along the blade; the bottom-outer corner is a big round (the fuel dial sits over it); < 0 inside
float cardD(vec2 p, float right) {
    float fx = u_cardTop.x * p.x * p.x + u_cardTop.y * p.x + u_cardTop.z;
    float slope = 2.0 * u_cardTop.x * p.x + u_cardTop.y;
    float dTop = (fx - p.y) / sqrt(1.0 + slope * slope);
    float dLeft = u_card.x - p.x;
    float dBot = p.y - u_card.y;
    float d = smax(dTop, dLeft, u_card.w);
    d = max(d, dBot);
    vec2 cc = vec2(u_card.x + u_card.z, u_card.y - u_card.z);
    if (p.x < cc.x && p.y > cc.y) d = max(d, length(p - cc) - u_card.z);
    d = max(d, p.x - (bladeX(p.y) - u_bladeB.y));
    if (right > 0.5 && u_cardCutR.z > 0.0) d = max(d, length(p - u_cardCutR.xy) - u_cardCutR.z);
    return d;
}
// the card: near-black (the panel brightens every dark tint, so the fill stays tiny), a shade lighter and bluer at
// the top, with a faint lighter rim
vec4 card(vec2 p, vec2 dial, float right, vec4 c) {
    float d = cardD(p, right);
    if (d > 2.0) return c;
    float top = u_cardTop.z - u_cardTop.y * u_cardTop.y / (4.0 * u_cardTop.x);   // the curve's lowest y (its vertex)
    float fy = clamp((p.y - top) / max(u_card.y - top, 1.0), 0.0, 1.0);
    float grey = u_cardFill * mix(1.3, 0.75, fy);
    c = over(vec4(vec3(grey, grey, grey * 1.18), cov(d)), c);
    // the rim stops inside the dial's area (as on the M8, where the dial covers the card's edge), so no label sits on it
    float hide = 1.0 - smoothstep(118.0, 130.0, length(p - dial));
    c = over(vec4(0.5, 0.53, 0.58, 0.3 * cov(abs(d + 1.2) - 0.9) * (1.0 - hide)), c);
    return c;
}
// the tyre block: the car seen from above (outline body, four wheels) between the four readouts,
// a divider under each front pair, a tick above and below the car
vec4 tyreBlock(vec2 p, vec4 c) {
    if (u_tyre.z <= 0.0) return c;
    vec2 q = (p - u_tyre.xy) / u_tyre.z;
    if (abs(q.x) > 80.0 || abs(q.y) > 70.0) return c;
    float body = abs(sdRoundBox(q, vec4(-11.0, -20.0, 22.0, 40.0), 7.0)) - 1.1;
    vec2 a = vec2(abs(q.x) - 13.5, abs(q.y) - 11.0);
    float wheel = max(abs(a.x) - 2.2, abs(a.y) - 4.5);
    float hl = min(segD(q, vec2(-68.0, 0.0), vec2(-28.0, 0.0)), segD(q, vec2(28.0, 0.0), vec2(68.0, 0.0))) - 0.9;
    float vt = min(segD(q, vec2(0.0, -62.0), vec2(0.0, -42.0)), segD(q, vec2(0.0, 42.0), vec2(0.0, 62.0))) - 0.9;
    c = over(vec4(0.72, 0.76, 0.82, cov(min(body, min(hl, vt)) * u_tyre.z)), c);
    c = over(vec4(0.36, 0.78, 0.42, cov(wheel * u_tyre.z)), c);
    return c;
}
// a setup level bar: s.y segments slanted, number lit (1-based) red, the rest grey
vec4 segbar(vec2 p, vec4 b, vec2 s, vec4 c) {
    if (b.w <= 0.0 || p.y < b.y - 1.0 || p.y > b.y + b.w + 1.0 || p.x < b.x - 1.0 || p.x > b.x + b.z + 1.0) return c;
    float fy = (p.y - b.y) / b.w;
    float x = p.x - b.x - u_segSlant * (1.0 - fy);
    float gap = 10.0;
    float slot = (b.z - u_segSlant + gap) / s.y;
    float i = floor(x / slot);
    float fx = x - i * slot;
    float a = clamp(fx + 0.5, 0.0, 1.0) * clamp(slot - gap - fx + 0.5, 0.0, 1.0) * clamp(p.y - b.y + 0.5, 0.0, 1.0) * clamp(b.y + b.w - p.y + 0.5, 0.0, 1.0);
    if (i < 0.0 || i >= s.y || a <= 0.0) return c;
    bool on = abs(i + 1.0 - s.x) < 0.5;
    vec3 col = on ? u_red * mix(0.85, 1.0, fx / (slot - gap)) : vec3(0.5, 0.53, 0.58);
    return over(vec4(col, (on ? 1.0 : 0.8) * a), c);
}

// a side dial as the M8 draws it, traced off the photo: not a round gauge but a tall thin bracket cut from big
// circles. The glass lies inside a circle of radius 120 round the anchor g.xy and outside one of radius 180 round
// (57, -68), so it is ~20 px wide at the top and widens to ~50 at the bottom; a hatched chrome bezel (an arc between
// radii 113 and 124 round (-13, 11)) runs down its outer side. The level reads by height: the glass is lit from the
// bottom up to the level, dark above it (a thin bright line along its outer edge), and a horizontal red streak runs in
// from the outer edge at the level. Fixed streaks mark the end zones (zones 0, fuel: the reserve at the bottom; 1, oil:
// blue at the cold bottom end, red at the hot top end). Units are the photo's px with g.z = 120 there.
// Drawn in the left frame; the right dial comes through the mirror.
vec4 streak(vec2 q, float py, float len, vec3 col, float k, vec4 c) {
    float xo = -sqrt(max(14400.0 - py * py, 0.0)) - 3.0;                         // the glass's outer edge at that height
    float dx = q.x - (xo + len * 0.5), dy = abs(q.y - py);
    float taper = 1.0 - clamp(abs(dx) / (len * 0.5), 0.0, 1.0);
    float sd = (max(abs(dx) - len * 0.5, dy - (1.2 + 2.3 * taper))) * k;
    c = over(vec4(col, 0.3 * exp(-max(sd, 0.0) / (5.0 * k))), c);
    return over(vec4(mix(col, vec3(1.0, 0.55, 0.5), 0.25 * taper), cov(sd)), c);
}
vec4 gauge(vec2 p, vec4 g, float zones, vec4 c) {
    float k = g.z / 120.0;
    vec2 q = (p - g.xy) / k;
    if (q.x < -140.0 || q.x > 70.0 || q.y < -22.0 || q.y > 140.0) return c;
    float v = clamp(g.w, 0.0, 1.0);
    // the bezel: double-edged and hatched, from its top end down round to its bottom end
    vec2 qb = q - vec2(-13.0, 11.0);
    float rb = length(qb);
    if (q.y > -16.0 && q.x < -30.0 && rb > 111.0 && rb < 126.0) {
        float ab = atan(qb.y, qb.x);
        float hatch = step(0.5, fract(ab * 30.0));
        float edge = max(cov((abs(rb - 112.5)) * k - 0.8), cov((abs(rb - 124.0)) * k - 0.8));
        float body = (rb > 112.5 && rb < 124.0) ? 0.4 + 0.35 * hatch : 0.0;
        c = over(vec4(0.8, 0.82, 0.88, min(1.0, body + 0.7 * edge)), c);
    }
    // the glass
    float dOut = 120.0 - length(q);
    float dIn = length(q - vec2(57.0, -68.0)) - 180.0;
    float inside = min(min(dOut, dIn), min(q.y + 10.0, 14.0 - q.x));
    if (zones > 0.5) inside = min(min(inside, 104.0 - q.y), -30.0 - q.x);       // the oil glass ends higher and shorter (photo: y 564, x 1686)
    if (inside > -1.5) {
        float f = clamp(dOut / max(dOut + max(dIn, 0.0), 1.0), 0.0, 1.0);        // 0 at the outer edge, 1 at the inner
        float yv = zones > 0.5 ? mix(97.0, 7.0, v) : mix(100.0, 2.0, v);
        float lit = smoothstep(yv - 2.0, yv + 4.0, q.y);
        vec4 dark = vec4(0.85, 0.87, 0.92, 0.75 * (1.0 - smoothstep(0.0, 6.0, dOut)));
        vec4 bright = vec4(mix(vec3(0.96, 0.97, 0.99), vec3(0.55, 0.57, 0.63), f), mix(1.0, 0.55, f));
        vec4 glass = mix(dark, bright, lit);
        c = over(vec4(glass.rgb, glass.a * cov(-inside * k)), c);
        c = over(vec4(1.0, 1.0, 1.0, 0.7 * cov(abs(inside * k) - 0.6) * (1.0 - lit) * step(dOut, 3.0)), c);
    }
    float yv = zones > 0.5 ? mix(97.0, 7.0, v) : mix(100.0, 2.0, v);
    if (zones > 0.5) {
        c = streak(q, -8.0, 44.0, u_red, k, c);                                    // hot end, above the top label as the photo
        c = streak(q, 101.0, 34.0, vec3(0.3, 0.55, 1.0), k, c);                    // cold end, along the glass's bottom
    } else {
        c = streak(q, 112.0, 50.0, u_red, k, c);                                   // reserve
    }
    c = streak(q, yv, 38.0, u_red, k, c);                                          // the level, across the glass only
    return c;
}

void main() {
    vec2 p = v_uv * u_size;
    vec2 pm = vec2(u_size.x - p.x, p.y);        // the right half, mirrored into the left frame
    vec4 c = vec4(0.0, 0.0, 0.0, 1.0);           // black, as the M8

    // the two cards: the left one as laid out, the right one its mirror
    c = card(p, u_gaugeL.xy, 0.0, c);
    c = card(pm, vec2(u_size.x - u_gaugeR.x, u_gaugeR.y), 1.0, c);

    // centre line, bright caps at both ends
    if (abs(p.y - u_line.y) < 6.0) {
        c = over(vec4(0.62, 0.66, 0.73, 0.8 * cov(segD(p, u_line.xy, u_line.zy) - 1.6)), c);
        float l = segD(p, u_line.xy + vec2(6.0, 0.0), u_line.xy + vec2(u_line.w, 0.0)) - 2.0 - 1.2 * clamp((p.x - u_line.x) / u_line.w, 0.0, 1.0);
        float r = segD(p, u_line.zy - vec2(u_line.w, 0.0), u_line.zy - vec2(6.0, 0.0)) - 2.0 - 1.2 * clamp((u_line.z - p.x) / u_line.w, 0.0, 1.0);
        c = over(vec4(0.95, 0.96, 0.98, cov(min(l, r))), c);
    }

    c = tyreBlock(p, c);

    // the side dials, traced off the M8 photo: the glass crescent, the fuel one as laid out, the oil one its mirror
    c = gauge(p, u_gaugeL, 0.0, c);
    c = gauge(pm, vec4(u_size.x - u_gaugeR.x, u_gaugeR.yzw), 1.0, c);

    c = segbar(p, u_seg0, vec2(u_segLit.x, u_segMax.x), c);
    c = segbar(p, u_seg1, vec2(u_segLit.y, u_segMax.y), c);
    c = segbar(p, u_seg2, vec2(u_segLit.z, u_segMax.z), c);
    c = segbar(p, u_seg3, vec2(u_segLit.w, u_segMax.w), c);

    // tricolour mark: three slanted bars
    if (u_mark.z > 0.0) {
        vec2 m = (p - u_mark.xy) / u_mark.z;
        if (m.y > -1.0 && m.y < 21.0 && m.x > -2.0 && m.x < 60.0) {
            float lx = m.x - 7.0 * (1.0 - m.y / 20.0);
            float i = floor(lx / 16.0);
            float fx = lx - i * 16.0;
            float inside = cov((max(abs(fx - 6.5) - 6.5, abs(m.y - 10.0) - 10.0)) * u_mark.z);
            vec3 mc = i < 0.5 ? vec3(0.31, 0.71, 1.0) : (i < 1.5 ? vec3(0.17, 0.29, 0.78) : vec3(0.9, 0.13, 0.17));
            if (i >= 0.0 && i <= 2.0) c = over(vec4(mc, inside), c);
        }
    }
    gl_FragColor = c;
}
`;
const MTACH = `// The M theme's rev bar (GLSL ES 1.00), after the M8's: a bowed glass blade (the curve bends at u_geoA.z with a
// large roundness, so it reads as one arc), wide at 0 rpm and narrow at the top, with a bright silver outer
// edge and bright ticks running in from it every 1000 rpm. The part below the rpm is lit dim grey, a glowing red
// block rides the blade at the rpm (the M8's marker), an outlined grey foot block fills the bottom 20 px, orange dashes sit before
// the redline and a solid red line past it. Drawn as the left bar; u_side 1 mirrors it. v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_side;
uniform vec4 u_geoA;      // y at 0 rpm, y at max, y of the bend, outer-edge x at the bend (layer px, left frame)
uniform vec3 u_geoB;      // slope above the bend, slope below it, bend roundness px
uniform vec3 u_wid;       // blade width at 0 rpm, at max, extra at the bend
uniform float u_ticks;    // max / 1000
uniform float u_value;    // 0..1
uniform float u_orange;   // 0..1, orange dashes from here
uniform float u_redFrom;  // 0..1, red dashes from here (the redline)
uniform float u_shiftNow;
uniform vec3 u_red;

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }

void main() {
    vec2 p = v_uv * u_size;
    if (u_side > 0.0) p.x = u_size.x - p.x;
    float y0 = u_geoA.x, y8 = u_geoA.y, ym = u_geoA.z, xm = u_geoA.w;
    float dy = p.y - ym;
    float k = dy < 0.0 ? u_geoB.x : u_geoB.y;
    float sq = sqrt(dy * dy + u_geoB.z * u_geoB.z);
    float xo = xm + k * (sq - u_geoB.z);
    float slope = k * dy / sq;
    float d = (p.x - xo) / sqrt(1.0 + slope * slope);      // + = into the blade, towards the middle
    float t = (y0 - p.y) / (y0 - y8);
    float w = mix(u_wid.x, u_wid.y, clamp(t, 0.0, 1.0)) + u_wid.z * exp(-dy * dy / 22000.0);
    vec4 c = vec4(0.0);
    if (t >= 0.0 && t <= 1.0) {
        float inBand = clamp(d + 0.5, 0.0, 1.0) * clamp(w - d + 0.5, 0.0, 1.0);
        float across = clamp(d / w, 0.0, 1.0);
        float yn = y0 - u_value * (y0 - y8);
        vec4 g = vec4(0.62, 0.67, 0.74, mix(0.42, 0.06, across));          // empty glass (bright at the outer edge, as the M8's)
        if (p.y > yn) g = u_shiftNow > 0.5 ? vec4(u_red * 0.8, 0.6) : vec4(mix(vec3(0.86, 0.88, 0.92), vec3(0.6, 0.63, 0.68), across), mix(0.34, 0.22, across));
        // the foot: the bottom 20 px as an outlined grey block, as the M8 draws it
        if (p.y > y0 - 20.0) g = over(vec4(0.7, 0.72, 0.78, 0.22), g);
        g = over(vec4(0.9, 0.92, 0.95, 0.7 * cov(min(abs(p.y - (y0 - 19.0)), abs(p.y - (y0 - 1.5))) - 0.8)), g);
        // the marker: a red block at the rpm with a glow either side of it
        float dm = abs(p.y - yn);
        g = over(vec4(u_red, 0.5 * exp(-dm / 26.0)), g);
        g = over(vec4(mix(u_red, vec3(1.0, 0.45, 0.4), 0.35 * cov(dm - 5.0)), cov(dm - 14.0)), g);
        c = vec4(g.rgb, g.a * inBand);
        c = over(vec4(0.93, 0.95, 0.98, cov(abs(d) - 1.6)), c);               // outer edge
        c = over(vec4(1.0, 1.0, 1.0, 0.3 * cov(abs(d - 4.0) - 0.6)), c);       // its bevel
        c = over(vec4(0.66, 0.7, 0.76, 0.75 * cov(abs(d - w) - 0.8)), c);      // inner edge
        // BMW's marks: a solid red line from the redline, a few orange dashes in the run-up to it
        bool redM = t >= u_redFrom && d > 6.0 && d < 11.0;
        bool orM = t >= u_orange && t < u_redFrom - 0.01 && d > 6.0 && d < 11.0 && mod(p.y, 20.0) < 7.0;
        if (redM || orM) {
            c = over(vec4(redM ? u_red : vec3(1.0, 0.6, 0.1), 0.95), c);
        }
    }
    // ticks every 1000 rpm: bright, from the outer edge 24 px into the glass, as the M8 draws them
    float kk = floor(t * u_ticks + 0.5);
    float yk = y0 - kk / u_ticks * (y0 - y8);
    if (kk >= 0.0 && kk <= u_ticks && d > -2.0 && d < 24.0) {
        float ty = abs(p.y - yk) - 1.5;
        c = over(vec4(0.93, 0.95, 0.98, cov(ty)), c);
    }
    gl_FragColor = c;
}
`;
const SDASH = `// The Sport theme in one cluster-render "effect" layer (GLSL ES 1.00), after BMW's Live Cockpit Sport view:
// a blue speed bracket left and a red rev bracket right (the left one mirrored). Each is a thin bright outer
// line, a band that fills from the bottom (white marker at the value), a dark gap and a thin inner line round a
// black middle: plain black, or BMW's map through a see-through rounded hole (u_hole; only the fuel and oil bars
// and the bottom strip draw over it). Two-tone fuel and oil bars inside the brackets, a blue / red strip at the bottom
// (optionally two bars from its middle out: the throttle left, the brake right). v_uv (0,0) is
// the top-left. The backdrop is pure black: the car brightens dark tints (seen Nov 5 2026), so no dark panels.
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
uniform vec4 u_holeMask;  // a rectangle kept black inside the window: x, y, w, h px (w 0 = none)
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
    float seg = fract(h * 4.0);
    float div = cov(min(seg, 1.0 - seg) * (yb - yt) / 4.0 - 1.1);        // dark lines between the four segments
    float body = cov(abs(side) - 10.0) * ends;
    vec3 off = vec3(0.30, 0.32, 0.37), edge = vec3(0.47, 0.49, 0.55);
    vec3 lit = mix(vec3(0.78, 0.8, 0.84), vec3(0.97, 0.98, 1.0), clamp(h / max(val, 0.05), 0.0, 1.0));
    bool on = val > 0.001 && h <= val;
    vec3 col = on ? lit : mix(off, edge, 1.0 - cov(abs(side) - 8.5));
    c = over(vec4(col, (on ? 1.0 : 0.92) * body), c);
    c = over(vec4(0.0, 0.0, 0.0, 0.85 * body * div * step(0.02, h) * step(h, 0.98)), c);
    // the rail
    float rs = side - rail * 15.0;
    float r = cov(abs(rs) - 1.3) * ends;
    vec3 rc = vec3(0.9, 0.92, 0.96);
    if (zones > 0.5 && h < 0.12) rc = vec3(0.25, 0.5, 1.0);
    if (zones > 0.5 && h > 0.9) rc = vec3(1.0, 0.2, 0.22);
    c = over(vec4(rc, 0.95 * r), c);
    return c;
}

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
    vec4 c = vec4(0.0, 0.0, 0.0, 1.0);

    c = bracket(p, u_speed, 2.0, 2.0, u_ticks.x, BLUE_LINE, BLUE_BAND, 0.95, BLUE_LIT, BLUE_LIT2, BLUE_IN, c);
    c = bracket(pm, u_rpm, u_redFrom, u_orange, u_ticks.y, RED_LINE, RED_BAND, 0.95, RED_LIT * 0.85, RED_LIT, RED_IN, c);
    // the map window: a rounded hole cut out of the backdrop and brackets, so BMW's map shows clean; the fuel and
    // oil bars and the bottom strip draw over it, as BMW's own Sport view lays them beside the map
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
        if (u_holeMask.z > 0.0) {
            vec2 mq = abs(p - (u_holeMask.xy + u_holeMask.zw * 0.5)) - u_holeMask.zw * 0.5;
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
    c = bar(p, u_fuelSeg, u_fuel, 0.0, -1.0, c);
    c = bar(p, u_oilSeg, u_oil, 1.0, 1.0, c);
    // the bottom line between the brackets
    if (abs(p.y - u_geo.z) < 3.0 && abs(p.x - u_size.x * 0.5) < u_size.x * 0.5 - outerX(u_geo.z))
        c = over(vec4(mix(BLUE_LINE, RED_LINE, step(u_size.x * 0.5, p.x)) * 0.8, cov(abs(p.y - u_geo.z) - 1.2)), c);

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
    gl_FragColor = c;
}
`;


const ATEXT = `// Atlas text for a cluster-render "effect" layer (GLSL ES 1.00): u_cells equal cells across the layer, each
// showing one glyph of the R8 glyph atlas bound to u_font (u_grid.x columns by u_grid.y rows of cells), picked
// by the codes in u_text (32 codes, 4 to a vec4; below 0 = empty). A new value is one uniform message, no
// pixels. After robertnisipeanu/idrive-apps js/showcase.js (TEXT_FS). v_uv (0,0) is the top-left.
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_font;
uniform vec4 u_text[8];
uniform float u_cells;
uniform vec2 u_grid;
uniform vec4 u_color;

float code(float cell) {
    float slot = floor(cell / 4.0), lane = cell - slot * 4.0;
    vec4 v = u_text[0];
    for (int i = 1; i < 8; i++) if (float(i) == slot) v = u_text[i];
    return lane < 0.5 ? v.x : lane < 1.5 ? v.y : lane < 2.5 ? v.z : v.w;
}

void main() {
    float x = v_uv.x * u_cells;
    float c = code(floor(x));
    float col = mod(c, u_grid.x), row = floor(c / u_grid.x);
    vec2 uv = vec2((col + fract(x)) / u_grid.x, (row + v_uv.y) / u_grid.y);
    float ink = c < 0.0 ? 0.0 : texture2D(u_font, uv).r;
    gl_FragColor = vec4(u_color.rgb, u_color.a * ink);
}
`;

const RDASH = `// The Regal theme in one cluster-render "effect" layer (GLSL ES 1.00), after a 1987 Buick Regal's digital-and-needle
// dash: chrome-framed pods left and right (a needle gauge each, pivoting from the pod's inner edge, and lamps under it),
// a centre panel holding a swinging speed needle over a straight row of numbers (the pivot hidden below), two orange
// VFD windows, a fuel needle and an LED rev bar. v_uv (0,0) is the top-left. All the numbers are text widgets over it.
// Big areas stay pure black (the car brightens dark tints); only the frames are grey.
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
uniform vec2 u_spdVirt;   // where the numbers sit: a far pivot's height below the number row, its half sweep (rad)
uniform float u_speedV;   // 0..1 along the scale, below 0 under the first mark (the rest position at 0)
uniform vec3 u_spdK;      // the speed scale: mph at the middle, mph at the end, mph between marks
uniform vec4 u_fuelG;     // fuel: pivot x, y, tick inner r, outer r
uniform float u_fuelV;    // 0..1
uniform vec4 u_podG;      // the left pod's needle: pivot x, y, tick inner r, outer r (right: mirrored)
uniform vec2 u_podV;      // left (battery), right (coolant) 0..1, bottom to top
uniform vec4 u_led;       // LED rev bar x, y, w, h
uniform vec3 u_ledV;      // segments, lit 0..1, yellow from 0..1 (the shift point)
uniform vec4 u_gearBox;   // the lit gear box: first letter's box x, y, w, h
uniform vec2 u_gearV;     // letter pitch px, which letter (-1 none)
uniform vec4 u_lampB;     // the BRAKE lamp box (left pod; the right pod's mirror is SERVICE ENGINE SOON, never lit)
uniform vec3 u_arrow;     // the left turn arrow: centre x, y, size (right: mirrored)
uniform vec4 u_lamps;     // brake, left turn, right turn on (1) / off (0)
uniform vec2 u_batIcon;   // the battery glyph's centre

const vec3 CHROME = vec3(0.62, 0.64, 0.68);
const vec3 CHROME2 = vec3(0.32, 0.33, 0.36);
const vec3 TICK = vec3(0.95, 0.95, 0.95);
const vec3 AMBER = vec3(1.0, 0.63, 0.16);
const vec3 NEEDLE = vec3(1.0, 0.8, 0.78);
const vec3 LED_ON = vec3(1.0, 0.24, 0.06);
const vec3 LED_Y = vec3(1.0, 0.86, 0.16);
const vec3 LED_OFF = vec3(0.16, 0.03, 0.02);
const vec3 GEAR_BOX = vec3(0.78, 0.13, 0.04);
const vec3 LAMP_R = vec3(1.0, 0.27, 0.08);
const vec3 LAMP_OFF = vec3(0.13, 0.04, 0.03);
const vec3 GREEN = vec3(0.2, 0.92, 0.35);

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
// a side pod's gauge (sgn -1: the left pod, pointing left; +1 the right): 5 marks over +-50 deg, the long ones at the ends
// and the middle, and its needle
vec3 podGauge(vec2 p, vec2 pv, float r0, float r1, float sgn, float v, vec4 win, vec3 c) {
    for (int i = 0; i < 5; i++) {
        float f = float(i) / 4.0, a = sgn * (1.5708 + (f - 0.5) * 1.745);
        float lg = mod(float(i), 2.0) < 0.5 ? 1.0 : 0.0;
        c = mix(c, TICK, mark(p, pv, a, r0 + (1.0 - lg) * (r1 - r0) * 0.35, r1, 3.2));
    }
    float a = sgn * (1.5708 - (clamp(v, -0.03, 1.03) - 0.5) * 1.745);
    if (rbox(p, win, 6.0) < 0.0) c = needle(p, pv, a, r0 * 0.25, r1 + 14.0, 4.5, 2.5, c);
    return c;
}

void main() {
    vec2 p = v_uv * u_size;
    vec3 c = vec3(0.0);
    float W = u_size.x;
    vec4 podR = vec4(W - u_podL.x - u_podL.z, u_podL.y, u_podL.z, u_podL.w);
    vec4 winR = vec4(W - u_podWin.x - u_podWin.z, u_podWin.y, u_podWin.z, u_podWin.w);

    // frames
    c = frame(rbox(p, u_podL, 14.0), c);
    c = frame(rbox(p, podR, 14.0), c);
    c = frame(rbox(p, u_ctr, 12.0), c);
    c = mix(c, CHROME2, cov(abs(rbox(p, u_podWin, 8.0)) - 1.0));
    c = mix(c, CHROME2, cov(abs(rbox(p, winR, 8.0)) - 1.0));
    c = mix(c, CHROME2, cov(abs(rbox(p, u_win1, 8.0)) - 1.0));
    c = mix(c, CHROME2, cov(abs(rbox(p, u_win2, 8.0)) - 1.0));
    c = mix(c, CHROME2 * 0.9, cov(abs(rbox(p, u_vfdL, 7.0)) - 1.0));
    c = mix(c, CHROME2 * 0.9, cov(abs(rbox(p, u_vfdR, 7.0)) - 1.0));

    // speed: the numbers sit along a straight row where a far "virtual" pivot (u_spdVirt: its height below the number row,
    // half sweep) would put them, so they stay readable; the real needle pivots at u_spd.xy (on the frame under the window) and
    // turns to point at them, and each mark lies on the line from that pivot to its number
    vec2 sp = u_spd.xy;
    float numY = u_spd.z, tickY = u_spd.w, Hv = u_spdVirt.x, S = u_spdVirt.y;
    if (rbox(p, u_win1, 8.0) < 0.0) {
        // the scale runs 0..u_spdK.y mph, u_spdK.x at the middle (each half linear); a mark every u_spdK.z mph, the long ones
        // on the labelled speeds (5, 15, 25 ...: odd multiples of the step)
        float xr = sp.x + (p.x - sp.x) * (sp.y - numY) / max(sp.y - p.y, 1.0);   // where this pixel's ray meets the number row
        float f = (atan((xr - sp.x) / Hv) + S) / (2.0 * S);
        float mph = f <= 0.5 ? 2.0 * f * u_spdK.x : u_spdK.x + (f - 0.5) * 2.0 * (u_spdK.y - u_spdK.x);
        float m = floor(mph / u_spdK.z + 0.5) * u_spdK.z;
        if (m >= u_spdK.z && m <= u_spdK.y) {
            float mf = m <= u_spdK.x ? 0.5 * m / u_spdK.x : 0.5 + 0.5 * (m - u_spdK.x) / (u_spdK.y - u_spdK.x);
            float xm = sp.x + Hv * tan(-S + 2.0 * S * mf), major = mod(m / u_spdK.z, 2.0) > 0.5 ? 1.0 : 0.0;
            float a = atan(xm - sp.x, sp.y - numY);
            float y0 = tickY - mix(8.0, 13.0, major), y1 = tickY + mix(3.0, 9.0, major);
            vec2 dir = vec2(sin(a), -cos(a));
            float pe = abs(dot(p - sp, vec2(-dir.y, dir.x)));
            float d = max(pe - mix(2.0, 4.5, major), max(y0 - p.y, p.y - y1));
            c = mix(c, m == u_spdK.x ? AMBER : TICK, cov(d));
        }
        // the needle points at the speed's place on the number row; one length at every angle: straight up it reaches a little
        // above the numbers (the 55). u_speedV < 0: below the first mark, down to the rest position under the row at 0
        float xs = sp.x + Hv * tan(-S + 2.0 * S * clamp(u_speedV, -0.5, 1.0));
        float na = atan(xs - sp.x, sp.y - numY);
        if (rbox(p, u_vfdL, 7.0) > 0.0 && rbox(p, u_vfdR, 7.0) > 0.0) c = needle(p, sp, na, 0.0, sp.y - numY + 40.0, 5.5, 3.0, c);
    }

    // fuel: 5 marks over +-55 deg round a pivot under the lower window, and its needle
    vec2 fp = u_fuelG.xy;
    if (rbox(p, u_win2, 8.0) < 0.0) {
        for (int i = 0; i < 5; i++) {
            float a = (float(i) / 4.0 - 0.5) * 1.92;
            float lg = (i == 0 || i == 2 || i == 4) ? 1.0 : 0.0;
            c = mix(c, TICK, mark(p, fp, a, u_fuelG.z + (1.0 - lg) * 8.0, u_fuelG.w, 3.0));
        }
        c = needle(p, fp, (clamp(u_fuelV, -0.03, 1.03) - 0.5) * 1.92, u_fuelG.z * 0.4, u_fuelG.w + 12.0, 4.5, 2.5, c);
    }

    // the side pods' gauges (the pivots sit behind each pod's inner edge)
    vec2 pvL = u_podG.xy, pvR = vec2(W - u_podG.x, u_podG.y);
    if (rbox(p, u_podWin, 8.0) < 0.0) c = podGauge(p, pvL, u_podG.z, u_podG.w, -1.0, u_podV.x, u_podWin, c);
    if (rbox(p, winR, 8.0) < 0.0) c = podGauge(p, pvR, u_podG.z, u_podG.w, 1.0, u_podV.y, winR, c);

    // battery glyph: a box with two terminals
    vec2 bq = p - u_batIcon;
    float bat = abs(rbox(bq, vec4(-14.0, -8.0, 28.0, 17.0), 2.0)) - 1.3;
    bat = min(bat, rbox(bq, vec4(-10.0, -12.0, 5.0, 4.0), 0.5));
    bat = min(bat, rbox(bq, vec4(5.0, -12.0, 5.0, 4.0), 0.5));
    c = mix(c, TICK, cov(bat));

    // LED rev bar: segments with a gap, lit red-orange up to the revs, yellow from the shift point
    if (p.x >= u_led.x && p.x < u_led.x + u_led.z && p.y >= u_led.y && p.y < u_led.y + u_led.w) {
        float n = u_ledV.x, pitch = u_led.z / n, i = floor((p.x - u_led.x) / pitch);
        float lx = p.x - u_led.x - i * pitch;
        float d = rbox(vec2(lx, p.y), vec4(1.5, u_led.y, pitch - 4.5, u_led.w), 1.5);
        bool lit = (i + 0.5) / n <= u_ledV.y;
        vec3 col = lit ? ((i + 0.5) / n >= u_ledV.z ? LED_Y : LED_ON) : LED_OFF;
        c = mix(c, col, cov(d));
    }

    // the lit gear letter's box
    if (u_gearV.y >= 0.0) c = mix(c, GEAR_BOX, cov(rbox(p, vec4(u_gearBox.x + u_gearV.x * u_gearV.y, u_gearBox.yzw), 3.0)));

    // lamps: BRAKE (left), SERVICE ENGINE SOON (right, never lit), the turn arrows
    vec4 lampR = vec4(W - u_lampB.x - u_lampB.z, u_lampB.yzw);
    c = mix(c, mix(LAMP_OFF, LAMP_R, u_lamps.x), cov(rbox(p, u_lampB, 3.0)));
    c = mix(c, LAMP_OFF, cov(rbox(p, lampR, 3.0)));
    for (int s = 0; s < 2; s++) {
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
}
`;

module.exports = { rdash: RDASH, shiftbar: SHIFTBAR, arc: ARC, revbar: REVBAR, lights: LIGHTS, fill: FILL, box: BOX, grid: GRID, segbar: SEGBAR, mdash: MDASH, mtach: MTACH, sdash: SDASH, boxes: BOXES, atext: ATEXT };
