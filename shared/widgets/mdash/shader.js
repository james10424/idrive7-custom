"use strict";
/** The "mdash" widget's fragment shader (GLSL ES 1.00) for its cluster-render effect layer; index.js sends its uniforms. */
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

module.exports = MDASH;
