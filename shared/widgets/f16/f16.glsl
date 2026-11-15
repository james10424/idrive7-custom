// An F-16 style HUD for a cluster-render effect layer (GLSL ES 1.00), one layer the visible window's size (v_uv (0,0)
// the top-left; u_size px). In HUD green (u_color), lines antialiased about 1.5 px wide:
//   the airspeed tape on the left (the car's speed, a box with it in digits at the tape's middle), the altitude tape
//   on the right (the rpm / 10, its box likewise), the pitch ladder and the horizon line (pitch and roll, from the
//   car and the g; sliding sideways with the flight path vector; rungs every 5 deg, dashed below the horizon, numbered both ends), the flight path vector (moved by
//   the g), the bank angle scale under it (ticks at 0, 10, 20, 30, 45 deg, a pointer at the roll) and, when the car
//   gives a heading, the heading tape at the top.
// Every number is read from one glyph atlas (u_font, R8; u_grid its columns and rows, u_dig the cells of 0..9), and
// a pixel is in at most one number, so the shader reads the atlas once. The app sends every value; no lookups.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;      // the layer, px
uniform vec4 u_color;     // HUD green (straight alpha)
uniform sampler2D u_font;
uniform vec2 u_grid;      // atlas columns, rows
uniform vec4 u_cell;      // atlas cell w, h px; a digit's advance px; 1 when the atlas is there
uniform vec4 u_dig[3];    // atlas cells of 0..9 (10 of 12)
uniform vec4 u_nesw;      // atlas cells of N, E, S, W (the heading tape's 0, 90, 180, 270 deg)
uniform vec4 u_spd;       // speed (display unit), tape px a unit, label step, the scale's top (0 .. top)
uniform vec4 u_rpm;       // rpm / 10, tape px a unit, label step, the scale's top
uniform vec4 u_att;       // pitch deg (nose up +), roll rad, flight path vector x, y px (from the centre)
uniform float u_lat;      // the ladder's and the horizon's sideways shift, px (the lateral g: centred on the vector)
uniform vec4 u_hdg;       // heading deg, 1 when known, px a degree, 0
uniform vec4 u_geo;       // ladder centre x, y; px a degree of pitch; the tapes' half height
uniform vec4 u_box;       // speed tape's line x, rpm tape's line x, tapes' middle y, 0
uniform vec4 u_bank;      // the bank scale: its centre x, y, radius, the ladder's lowest y

#define LINE 0.75
#define PI 3.14159265

float pick4(vec4 v, float i) { return i < 0.5 ? v.x : i < 1.5 ? v.y : i < 2.5 ? v.z : v.w; }
float digCode(float d) { return d < 3.5 ? pick4(u_dig[0], d) : d < 7.5 ? pick4(u_dig[1], d - 4.0) : pick4(u_dig[2], d - 8.0); }
// a line's coverage at distance d (px) from its centre
float ink(float d) { return 1.0 - smoothstep(LINE - 0.5, LINE + 0.5, abs(d)); }
// a horizontal segment x0..x1 at y
float hseg(vec2 p, float x0, float x1, float y) { return p.x < x0 - 1.0 || p.x > x1 + 1.0 ? 0.0 : ink(p.y - y) * clamp(min(p.x - x0, x1 - p.x) + 1.0, 0.0, 1.0); }
float vseg(vec2 p, float y0, float y1, float x) { return p.y < y0 - 1.0 || p.y > y1 + 1.0 ? 0.0 : ink(p.x - x) * clamp(min(p.y - y0, y1 - p.y) + 1.0, 0.0, 1.0); }
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

// The glyph cell a pixel falls in for a whole number (0 .. 999) right-aligned at a.x, its middle at a.y, digits
// scale k of the atlas's: (atlas cell, x, y in the cell 0..1), or a cell of -1 outside it.
vec3 number(vec2 p, vec2 a, float value, float k) {
    float adv = u_cell.z * k, h = u_cell.y * k;
    float v = floor(abs(value) + 0.5), nd = v < 9.5 ? 1.0 : v < 99.5 ? 2.0 : 3.0;
    float from = (a.x - p.x) / adv, dy = (p.y - (a.y - 0.5 * h)) / h;
    if (from < 0.0 || from >= nd || dy < 0.0 || dy > 1.0) return vec3(-1.0, 0.0, 0.0);
    float i = floor(from), d = mod(floor(v / pow(10.0, i) + 0.0001), 10.0);
    // the digit's advance, centred in its atlas cell
    float gx = 0.5 + ((1.0 - (from - i)) - 0.5) * adv / (u_cell.x * k);
    return vec3(digCode(d), gx, dy);
}
// the same with two digits always (a heading's tens: 03 for 30 deg)
vec3 number2(vec2 p, vec2 a, float value, float k) {
    float adv = u_cell.z * k, h = u_cell.y * k;
    float from = (a.x - p.x) / adv, dy = (p.y - (a.y - 0.5 * h)) / h;
    if (from < 0.0 || from >= 2.0 || dy < 0.0 || dy > 1.0) return vec3(-1.0, 0.0, 0.0);
    float i = floor(from), d = mod(floor(value / pow(10.0, i) + 0.0001), 10.0);
    float gx = 0.5 + ((1.0 - (from - i)) - 0.5) * adv / (u_cell.x * k);
    return vec3(digCode(d), gx, dy);
}

// A vertical tape: its line at x = lx, ticks toward side s (+1 right, -1 left), the value v in the middle (y = my),
// px a unit u, labels every step, minor ticks every half step, the scale 0 .. top, half height hh. Lines into
// col; the label a pixel falls in into cell (left of the line for s -1, right for s +1).
float tape(vec2 p, float lx, float s, float v, float u, float lstep, float top, float my, float hh, inout vec3 cell) {
    if (abs(p.y - my) > hh) return 0.0;
    float c = vseg(p, my - hh, my + hh, lx);
    float at = v + (my - p.y) / u;                         // the value at this pixel's height
    float minor = lstep * 0.5, n = floor(at / minor + 0.5), tv = n * minor;
    if (tv >= -0.001 && tv <= top + 0.001) {
        float ty = my - (tv - v) * u, len = mod(n, 2.0) < 0.5 ? 12.0 : 6.0;
        c = max(c, hseg(p, s < 0.0 ? lx - len : lx, s < 0.0 ? lx : lx + len, ty));
    }
    // the label of the nearest whole step, beside its long tick, kept clear of the box at the middle
    float lv = floor(at / lstep + 0.5) * lstep, ly = my - (lv - v) * u;
    if (lv >= -0.001 && lv <= top + 0.001 && abs(ly - my) > 20.0 && abs(ly - my) < hh - 8.0 && cell.x < 0.0) {
        vec2 a = s < 0.0 ? vec2(lx - 16.0, ly) : vec2(lx + 16.0 + 3.0 * u_cell.z * 0.62, ly);
        cell = number(p, a, lv, 0.62);
    }
    return c;
}

// A box at the tape's middle: x0 .. x1, its point toward the tape at px (the side the tape is), the value in it.
float box(vec2 p, float x0, float x1, float my, float tip, float value, inout vec3 cell) {
    float h = 15.0, c = 0.0, lo = min(x0, x1), hi = max(x0, x1);
    c = max(c, hseg(p, lo, hi, my - h));
    c = max(c, hseg(p, lo, hi, my + h));
    float far = tip > hi ? lo : hi, near = tip > hi ? hi : lo;
    c = max(c, vseg(p, my - h, my + h, far));
    // the point: two slanted edges from the near side's corners to the tip
    vec2 q = vec2(abs(p.x - near), abs(p.y - my));
    float run = abs(tip - near);
    if ((tip - near) * (p.x - near) >= 0.0 && q.x <= run + 1.0) {
        float e = (h - q.y) - q.x * h / run;   // on the edge where it's 0
        c = max(c, ink(e * run / sqrt(run * run + h * h)));
    }
    if (cell.x < 0.0) cell = number(p, vec2(hi - 7.0, my), value, 0.85);
    return c;
}

void main() {
    vec2 p = v_uv * u_size;
    vec3 cell = vec3(-1.0, 0.0, 0.0);
    float c = 0.0;
    vec2 ctr = u_geo.xy;
    float my = u_box.z, hh = u_geo.w;

    // the airspeed tape (left: labels left of its line) and its box; the altitude (rpm) tape on the right
    c = max(c, box(p, u_box.x - 92.0, u_box.x - 18.0, my, u_box.x - 4.0, u_spd.x, cell));
    c = max(c, tape(p, u_box.x, -1.0, u_spd.x, u_spd.y, u_spd.z, u_spd.w, my, hh, cell));
    c = max(c, box(p, u_box.y + 92.0, u_box.y + 18.0, my, u_box.y + 4.0, u_rpm.x, cell));
    c = max(c, tape(p, u_box.y, 1.0, u_rpm.x, u_rpm.y, u_rpm.z, u_rpm.w, my, hh, cell));

    // the pitch ladder and the horizon, between the tapes: in the horizon's frame (rolled), rung n is n * 5 deg
    // (under the heading tape while it shows)
    if (p.x > u_box.x + 8.0 && p.x < u_box.y - 8.0 && abs(p.y - my) < hh && p.y < u_bank.w && (u_hdg.y < 0.5 || p.y > 46.0)) {
        vec2 q = rot(p - ctr - vec2(u_lat, 0.0), -u_att.y);
        float t = u_att.x - q.y / u_geo.z, n = floor(t / 5.0 + 0.5);
        float y = (u_att.x - n * 5.0) * u_geo.z, d = q.y - y, ax = abs(q.x);
        if (abs(n) < 0.5) {
            // the horizon: one long line with a gap round the middle
            if (ax > 24.0) c = max(c, ink(d));
        } else if (abs(n) <= 18.0) {
            float dash = n < 0.0 ? step(mod(ax, 9.0), 5.5) : 1.0;
            if (ax > 34.0 && ax < 92.0) c = max(c, ink(d) * dash);
            // the end ticks, toward the horizon
            float tick = n > 0.0 ? 1.0 : -1.0;
            if (abs(ax - 92.0) < 1.5 && d * tick >= -1.0 && d * tick <= 8.0) c = max(c, ink(ax - 92.0));
            if (cell.x < 0.0) {
                vec2 qa = vec2(q.x < 0.0 ? -100.0 : 100.0 + 2.0 * u_cell.z * 0.55, y);
                cell = number(q, qa, abs(n) * 5.0, 0.55);
            }
        }
    }

    // the flight path vector: a ring, its wings and its fin
    vec2 f = p - ctr - u_att.zw;
    float r = length(f);
    c = max(c, ink(r - 6.0));
    if (abs(f.x) > 6.0 && abs(f.x) < 17.0) c = max(c, ink(f.y));
    if (abs(f.x) < 1.0 + LINE && f.y < -6.0 && f.y > -12.0) c = max(c, ink(f.x));

    // the bank angle scale at the bottom: ticks at 0, 10, 20, 30 and 45 deg from straight down, the pointer at the roll
    vec2 b = p - u_bank.xy;
    float br = length(b), ba = atan(b.x, b.y) * 180.0 / PI, aa = abs(ba);
    if (b.y > 0.0 && aa < 50.0) {
        float tk = aa < 37.5 ? floor(aa / 10.0 + 0.5) * 10.0 : 45.0;
        float len = tk < 0.5 ? 12.0 : tk > 44.0 || abs(tk - 30.0) < 0.5 ? 9.0 : 6.0;
        float off = (aa - tk) * PI / 180.0 * br;            // px from the tick's ray
        if (br > u_bank.z && br < u_bank.z + len) c = max(c, ink(off));
        vec2 pp = rot(b, -u_att.y);                         // the pointer, toward the low side (left bank: left)
        float py = u_bank.z - 2.0 - pp.y;                    // 0 at its tip, growing inward
        if (py >= 0.0 && py <= 9.0 && abs(pp.x) <= py * 0.55) c = max(c, 1.0);
    }

    // the heading tape at the top, only with a heading: ticks every 5 deg, every 10 numbered (in tens), a caret under
    if (u_hdg.y > 0.5 && abs(p.x - ctr.x) < 110.0 && p.y < 44.0) {
        float at = u_hdg.x + (p.x - ctr.x) / u_hdg.z;
        float n = floor(at / 5.0 + 0.5), hx = ctr.x + (n * 5.0 - u_hdg.x) * u_hdg.z;
        float len = mod(n, 2.0) < 0.5 ? 9.0 : 5.0;
        c = max(c, vseg(p, 30.0 - len, 30.0, hx));
        float ln = floor(at / 10.0 + 0.5), lx = ctr.x + (ln * 10.0 - u_hdg.x) * u_hdg.z;
        float h10 = mod(ln + 36.0, 36.0);
        if (cell.x < 0.0) {
            if (mod(h10, 9.0) < 0.5) {
                // a cardinal point: its letter, one glyph centred on the tick, a little bigger than the numbers
                float k = 0.7, w = u_cell.x * k, h = u_cell.y * k;
                vec2 g = vec2((p.x - (lx - 0.5 * w)) / w, (p.y - (11.0 - 0.5 * h)) / h);
                if (g.x >= 0.0 && g.x <= 1.0 && g.y >= 0.0 && g.y <= 1.0) cell = vec3(pick4(u_nesw, h10 / 9.0), g);
            } else cell = number2(p, vec2(lx + u_cell.z * 0.55, 11.0), h10, 0.55);
        }
        if (p.y > 32.0 && abs(p.x - ctr.x) <= (p.y - 32.0) * 0.6 + 0.5 && p.y < 39.0) c = max(c, 1.0);
    }

    // the one glyph read: the number this pixel is in
    if (cell.x >= 0.0 && u_cell.w > 0.5) {
        vec2 g = cell.yz;
        if (g.x >= 0.0 && g.x <= 1.0) {
            float col = mod(cell.x, u_grid.x), row = floor(cell.x / u_grid.x);
            c = max(c, texture2D(u_font, vec2((col + g.x) / u_grid.x, (row + g.y) / u_grid.y)).r);
        }
    }
    gl_FragColor = vec4(u_color.rgb, u_color.a * clamp(c, 0.0, 1.0));
}
