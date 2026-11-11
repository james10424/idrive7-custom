// Solid fill for a cluster-render "effect" layer (GLSL ES 1.00): u_color everywhere, except a
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
