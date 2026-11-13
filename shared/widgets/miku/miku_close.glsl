// Miku's close-up (GLSL ES 1.00): what she zooms into when the car stops, from its own baked atlas (u_atlas, straight
// alpha, ETC2; tools/live2d_bake's bakeClose, close.etc2). Every frame is the layer's size, laid out on a grid (u_grid,
// u_cropGrid), so nothing reads a table: first the zoom steps (the camera part of the way in, the expressions part of
// the way on), then the close-up's poses (sway left, middle, sway right, then the turn from the left to the right
// without the middle), then each pose's eyes half shut and shut, cropped to one rect (u_crop).
// u_zoom = (zoom 0 .. 1, turn -1 .. 1, brightness, ready): the app ramps zoom over 1 s when the car stops (and back when it
// pulls away) and eases turn toward the indicator. The camera (camera(), as MIKU's) zooms in; the standing layer under
// this one fades out by the first zoom step, then this layer blends the two nearest steps, each drawn through its own
// baked camera. Zoomed in, on u_clock (seconds 0 .. 4, sent by the app while she is zoomed in: the renderer's u_time
// didn't drive this layer on the car, Nov 10 2026, where a large u_time loses its fractions in a mediump float):
// she blinks every 2 s and sways (the head about u_pose.xy,
// -1 .. 1 over 4 s; the two nearest baked sways each turned onto the sway between, as the bake measured their turn,
// so they don't double); with the indicator on she turns her head that way (the nearest baked turns each slid onto
// the head's place between them) and doesn't sway.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_clock;   // seconds 0 .. 4, from the app while zoomed in (blink 2 s, sway 4 s)
uniform sampler2D u_atlas;
uniform vec2 u_atlasSize;
uniform vec4 u_zoom;     // zoom 0 .. 1, turn -1 .. 1, brightness, 1 once the atlas is there (0: draw nothing)
uniform vec4 u_cam;      // the layer's view of her standing: x, y, w, h in the standing frame's px

uniform vec4 u_cl[10];   // the bake's fixed values, as one array (cluster-render's 32 uniform names a layer)
                         // u_cl[0 .. 3]: each zoom step's camera and then the close-up's (padded with it), standing frame px
#define u_grid u_cl[4]   // frame cell w, h, columns, pad
#define u_cropGrid u_cl[5]   // crop cell w, h, columns, y of the first row
#define u_crop u_cl[6]   // the eyes' rect in a frame, px
#define u_pose u_cl[7]   // the sway's pivot x, y (frame px), its turn at the left and right sway (rad, clockwise)
                         // u_cl[8]: unused (the first four turn shifts, as up to Custom HUD 0.1.29)
uniform vec4 u_tsh[9];   // the turn frames' head shifts (px), left to right, four a vec4: up to 18 steps each way
#define u_frames u_cl[9]   // frame w, h, zoom steps, turn steps each way

vec4 tap(vec2 at, vec2 size, vec2 p) {
    if (p.x < 0.0 || p.y < 0.0 || p.x > size.x || p.y > size.y) return vec4(0.0);
    vec4 t = texture2D(u_atlas, (at + p) / u_atlasSize);
    return vec4(t.rgb * t.a, t.a);
}
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
#include "camera.glsl"

vec4 rectAt(float i) { return i < 0.5 ? u_cl[0] : i < 1.5 ? u_cl[1] : i < 2.5 ? u_cl[2] : u_cl[3]; }
// whole frame n's top-left in the atlas
vec2 slot(float n) {
    float row = floor((n + 0.5) / u_grid.z);
    return vec2(n - row * u_grid.z, row) * u_grid.xy + u_grid.w;
}
// crop m's top-left in the atlas
vec2 cropAt(float m) {
    float row = floor((m + 0.5) / u_cropGrid.z);
    return vec2(m - row * u_cropGrid.z, row) * u_cropGrid.xy + vec2(0.0, u_cropGrid.w) + u_grid.w;
}
// pose p (0 sway left, 1 middle, 2 sway right, then the turns) at frame px q, its eyes eh (0 open, 1 shut)
vec4 pose(float p, vec2 q, float eh) {
    vec4 c = tap(slot(u_frames.z + p), u_frames.xy, q);
    vec2 e = q - u_crop.xy;
    if (eh > 0.001 && e.x >= 0.0 && e.y >= 0.0 && e.x <= u_crop.z && e.y <= u_crop.w) {
        // half a pixel inside the crop: the crops sit edge to edge in the atlas, and the filtered read at the very
        // edge took in the next crop's row (a dark line along the eyes' rect while she blinked)
        e = clamp(e, vec2(0.5), u_crop.zw - 0.5);
        c = mix(c, tap(cropAt(2.0 * p), u_crop.zw, e), min(1.0, eh * 2.0));              // half shut
        c = mix(c, tap(cropAt(2.0 * p + 1.0), u_crop.zw, e), max(0.0, eh * 2.0 - 1.0));   // shut
    }
    return c;
}
// the turn's chain position j (0 .. 2 * steps; the middle is the sway): its pose and head shift
float turnPose(float j) { return j < u_frames.w ? 3.0 + j : 2.0 + j; }
float turnShift(float j) {
    float i = j < u_frames.w ? j : j - 1.0, q = floor(i / 4.0 + 0.01), r = i - q * 4.0;
    // GLSL ES 1.00 indexes a fragment shader's uniform array only by a constant or a loop's index
    vec4 v = vec4(0.0);
    for (int k = 0; k < 9; k++) if (abs(float(k) - q) < 0.5) v = u_tsh[k];
    float s = r < 0.5 ? v.x : r < 1.5 ? v.y : r < 2.5 ? v.z : v.w;
    return abs(j - u_frames.w) < 0.5 ? 0.0 : s;
}

void main() {
    float z = smoothstep(0.0, 1.0, clamp(u_zoom.x, 0.0, 1.0));
    if (z <= 0.0 || u_zoom.w < 0.5) { gl_FragColor = vec4(0.0); return; }
    float steps = u_frames.z;
    vec4 close = rectAt(steps);
    vec4 view = camera(z, u_cam, close);
    vec2 f = view.xy + v_uv * view.zw;   // standing frame px
    // the zoom steps at k / (steps + 1) of the way in, the close-up at the end: the two nearest
    float k = z * (steps + 1.0) - 1.0, j0 = min(floor(k), steps - 1.0), jf = k - j0;
    // zoomed in (from the last zoom step on): the sway, blinks and turn come in
    float zin = clamp(k - (steps - 1.0), 0.0, 1.0);
    vec4 c = vec4(0.0);
    if (k > steps - 1.0) {
        vec2 q = (f - close.xy) * u_frames.xy / close.zw;   // close-up frame px
        float t = u_clock;
        float turn = clamp(u_zoom.y, -1.0, 1.0) * zin;
        float bt = mod(t, 2.0);
        float eh = (smoothstep(0.0, 0.06, bt) * (1.0 - smoothstep(0.1, 0.22, bt))) * zin;
        // the sway, -1 .. 1 over 4 s, none while she turns: the two nearest baked sways, each turned to it
        float s = sin(t * 1.5708) * zin * (1.0 - smoothstep(0.0, 0.4, abs(turn)));
        float i0 = min(floor(s + 1.0), 1.0), sf = s + 1.0 - i0;
        float a0 = i0 < 0.5 ? u_pose.z : 0.0, a1 = i0 > 0.5 ? u_pose.w : 0.0, a = mix(a0, a1, sf);
        // the turn's two nearest along the chain; the sway pose is only needed when one of them is the middle
        bool turning = abs(turn) > 0.001;
        float n = 2.0 * u_frames.w, kt = (turn + 1.0) * u_frames.w;
        float t0 = min(floor(kt), n - 1.0), tf = kt - t0, t1 = t0 + 1.0;
        if (!turning || abs(t0 - u_frames.w) < 0.5 || abs(t1 - u_frames.w) < 0.5) {
            // the second sway pose only while it has weight (none while she turns: the sway is 0 then)
            c = pose(i0, rot(q - u_pose.xy, a0 - a) + u_pose.xy, eh);
            if (sf > 0.001) c = mix(c, pose(i0 + 1.0, rot(q - u_pose.xy, a1 - a) + u_pose.xy, eh), sf);
        }
        // the turn: the two nearest along the chain, each slid so the heads meet (above the shoulders)
        if (turning) {
            float h0 = turnShift(t0), h1 = turnShift(t1), hc = mix(h0, h1, tf);
            float wy = 1.0 - smoothstep(u_pose.y - 20.0, u_pose.y + 30.0, q.y);
            vec4 ca = abs(t0 - u_frames.w) < 0.5 ? c : pose(turnPose(t0), q + vec2((h0 - hc) * wy, 0.0), eh);
            vec4 cb = abs(t1 - u_frames.w) < 0.5 ? c : pose(turnPose(t1), q + vec2((h1 - hc) * wy, 0.0), eh);
            c = mix(ca, cb, tf);
        }
    }
    // the zoom steps: j0 (none before the first: the standing layer under this one) blended into j0 + 1 (the
    // close-up past the last)
    // (the nearer step sees less: where the view reaches past it, the wider step's pixels stand in)
    vec4 r0 = rectAt(max(j0, 0.0)), r1 = rectAt(j0 + 1.0);
    vec2 q1 = (f - r1.xy) * u_frames.xy / r1.zw;
    bool past = q1.x < 0.5 || q1.y < 0.5 || q1.x > u_frames.x - 0.5 || q1.y > u_frames.y - 0.5;
    // step j0 not read once it has no weight (zoomed in all the way), unless it stands in past j0 + 1's edge
    vec4 a = j0 < -0.5 || (jf > 0.999 && !past) ? vec4(0.0)
        : tap(slot(max(j0, 0.0)), u_frames.xy, (f - r0.xy) * u_frames.xy / r0.zw);
    vec4 b = j0 + 1.0 > steps - 0.5 ? c : tap(slot(j0 + 1.0), u_frames.xy, q1);
    if (j0 > -0.5 && past) b = a;
    c = mix(a, b, jf);
    vec3 rgb = c.rgb / max(c.a, 0.0001);
    gl_FragColor = vec4(rgb * u_zoom.z, c.a);
}
