// Segmented level bar for a cluster-render "effect" layer (GLSL ES 1.00): u_segs segments, the first
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
