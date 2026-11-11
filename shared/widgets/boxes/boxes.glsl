// The GT3 race dash's frame in one cluster-render "effect" layer (GLSL ES 1.00): the background u_bg over the
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
