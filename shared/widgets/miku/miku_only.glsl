// Miku in close-up only (GLSL ES 1.00), from a close.only bake (tools/live2d_bake): no standing figure and no zoom,
// her head and chest all the time, one layer the close-up's size, its atlas (u_atlas, straight alpha, ETC2) laid out
// on a grid (u_grid, u_cropGrid): first the in-steps (the expressions coming on: Yandere's hands rising to her
// cheeks, Blush), then the poses, each with its eyes half shut and shut cropped to one rect (u_crop): sway left,
// upright and sway right with the expressions on, the turn from the left to the right (u_frames.w each way), then the
// driving set without them, the lean from a full lean left to right (u_drv.x each way, upright in its middle).
// u_zoom = (expressions 0 .. 1, turn -1 .. 1, brightness, 1 once the atlas is there): the app brings the expressions
// on over about 0.8 s when the car has stood still for 1 s or an indicator is on, and off again as she drives on.
// At 0 she leans with the car (u_lean -1 braking .. 1 pulling away) and blinks; in between the in-steps play; at 1 she
// blinks, sways (none while she turns) and turns her head toward the indicator. Two nearest baked frames are blended
// everywhere, each slid so the heads meet (u_tsh: each turn and lean frame's head shift, px).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform float u_clock;   // seconds 0 .. 4, from the app (blink 2 s, sway 4 s)
uniform sampler2D u_atlas;
uniform vec2 u_atlasSize;
uniform vec4 u_zoom;     // expressions 0 .. 1, turn -1 .. 1, brightness, 1 once the atlas is there (0: draw nothing)
uniform float u_lean;    // -1 .. 1, driving
uniform vec4 u_tsh[9];   // the turn frames' head shifts (px), left to right, then the lean frames', four a vec4

uniform vec4 u_cl[10];   // the bake's fixed values, as one array (cluster-render's 32 uniform names a layer)
#define u_grid u_cl[4]   // frame cell w, h, columns, pad
#define u_cropGrid u_cl[5]   // crop cell w, h, columns, y of the first row
#define u_crop u_cl[6]   // the eyes' rect in a frame, px
#define u_pose u_cl[7]   // the sway's pivot x, y (frame px), its turn at the left and right sway (rad, clockwise)
#define u_drv u_cl[8]    // the lean's steps each way
#define u_frames u_cl[9]   // frame w, h, in-steps, turn steps each way

vec4 tap(vec2 at, vec2 size, vec2 p) {
    if (p.x < 0.0 || p.y < 0.0 || p.x > size.x || p.y > size.y) return vec4(0.0);
    vec4 t = texture2D(u_atlas, (at + p) / u_atlasSize);
    return vec4(t.rgb * t.a, t.a);
}
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
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
// whole frame n at frame px q, with crop pair m's eyes over it (m < 0: none), eh (0 open, 1 shut)
vec4 frameAt(float n, float m, vec2 q, float eh) {
    vec4 c = tap(slot(n), u_frames.xy, q);
    vec2 e = q - u_crop.xy;
    if (m > -0.5 && eh > 0.001 && e.x >= 0.0 && e.y >= 0.0 && e.x <= u_crop.z && e.y <= u_crop.w) {
        // half a pixel inside the crop: the crops sit edge to edge in the atlas
        e = clamp(e, vec2(0.5), u_crop.zw - 0.5);
        c = mix(c, tap(cropAt(2.0 * m), u_crop.zw, e), min(1.0, eh * 2.0));              // half shut
        c = mix(c, tap(cropAt(2.0 * m + 1.0), u_crop.zw, e), max(0.0, eh * 2.0 - 1.0));   // shut
    }
    return c;
}
// head shift i (0 the first turn frame; the lean frames after the turn's), px
float shiftAt(float i) {
    float q = floor(i / 4.0 + 0.01), r = i - q * 4.0;
    // GLSL ES 1.00 indexes a fragment shader's uniform array only by a constant or a loop's index
    vec4 v = vec4(0.0);
    for (int k = 0; k < 9; k++) if (abs(float(k) - q) < 0.5) v = u_tsh[k];
    return r < 0.5 ? v.x : r < 1.5 ? v.y : r < 2.5 ? v.z : v.w;
}
// the turn's chain position j (0 .. 2 * steps; the middle is the sway): its pose and head shift
float turnPose(float j) { return j < u_frames.w ? 3.0 + j : 2.0 + j; }
float turnShift(float j) {
    return abs(j - u_frames.w) < 0.5 ? 0.0 : shiftAt(j < u_frames.w ? j : j - 1.0);
}
// the lean's chain position m (0 .. 2 * steps, upright in the middle): its pose and head shift
float leanPose(float m) { return 3.0 + 2.0 * u_frames.w + m; }
float leanShift(float m) { return shiftAt(2.0 * u_frames.w + m); }

void main() {
    if (u_zoom.w < 0.5) { gl_FragColor = vec4(0.0); return; }
    vec2 q = v_uv * u_frames.xy;   // frame px: the layer is the close-up's size
    float y = clamp(u_zoom.x, 0.0, 1.0), t = u_clock;
    float bt = mod(t, 2.0);
    float eh = smoothstep(0.0, 0.06, bt) * (1.0 - smoothstep(0.1, 0.22, bt));
    // the heads meet above the shoulders: the slide fades out below the sway's pivot
    float wy = 1.0 - smoothstep(u_pose.y - 20.0, u_pose.y + 30.0, q.y);
    // every case blends two frames (so two frames' reads in all): pose p0 at q0 and p1 at q1 by f; a pose is whole
    // frame steps + p with crop pair p; the in-steps are whole frames 0 .. steps - 1 without crops (pose -1 - n)
    float steps = u_frames.z, p0, p1, f = 0.0, e = eh;
    vec2 q0 = q, q1 = q;
    if (y < 0.001) {
        // driving: the lean's two nearest frames, slid so the heads meet
        float n = u_drv.x, k = (clamp(u_lean, -1.0, 1.0) + 1.0) * n;
        float m0 = min(floor(k), 2.0 * n - 1.0);
        f = k - m0;
        float h0 = leanShift(m0), h1 = leanShift(m0 + 1.0), hc = mix(h0, h1, f);
        p0 = leanPose(m0);
        p1 = leanPose(m0 + 1.0);
        q0 = q + vec2((h0 - hc) * wy, 0.0);
        q1 = q + vec2((h1 - hc) * wy, 0.0);
    } else if (y < 0.999) {
        // the expressions coming on: driving upright, the in-steps, the stopped upright; no blink meanwhile
        float k = y * (steps + 1.0), i0 = min(floor(k), steps);
        f = k - i0;
        p0 = i0 < 0.5 ? leanPose(u_drv.x) : -i0;
        p1 = i0 + 1.0 > steps + 0.5 ? 1.0 : -(i0 + 1.0);
        e = 0.0;
    } else {
        // stopped (or an indicator on): the sway, -1 .. 1 over 4 s, none while she turns, and the turn
        float turn = clamp(u_zoom.y, -1.0, 1.0);
        float s = sin(t * 1.5708) * (1.0 - smoothstep(0.0, 0.4, abs(turn)));
        if (abs(turn) < 0.001) {
            // the two nearest baked sways, each turned onto the sway between (as the bake measured their turn)
            float i0 = min(floor(s + 1.0), 1.0);
            f = s + 1.0 - i0;
            float a0 = i0 < 0.5 ? u_pose.z : 0.0, a1 = i0 > 0.5 ? u_pose.w : 0.0, a = mix(a0, a1, f);
            p0 = i0;
            p1 = i0 + 1.0;
            q0 = rot(q - u_pose.xy, a0 - a) + u_pose.xy;
            q1 = rot(q - u_pose.xy, a1 - a) + u_pose.xy;
        } else {
            // the turn's two nearest along the chain (the middle is upright, turned by what's left of the sway)
            float n = 2.0 * u_frames.w, kt = (turn + 1.0) * u_frames.w;
            float t0 = min(floor(kt), n - 1.0), t1 = t0 + 1.0;
            f = kt - t0;
            float h0 = turnShift(t0), h1 = turnShift(t1), hc = mix(h0, h1, f);
            float sa = s > 0.0 ? s * u_pose.w : -s * u_pose.z;   // the sway's turn there
            bool mid0 = abs(t0 - u_frames.w) < 0.5, mid1 = abs(t1 - u_frames.w) < 0.5;
            p0 = mid0 ? 1.0 : turnPose(t0);
            p1 = mid1 ? 1.0 : turnPose(t1);
            q0 = mid0 ? rot(q - u_pose.xy, -sa) + u_pose.xy : q + vec2((h0 - hc) * wy, 0.0);
            q1 = mid1 ? rot(q - u_pose.xy, -sa) + u_pose.xy : q + vec2((h1 - hc) * wy, 0.0);
        }
    }
    // pose p >= 0: whole frame steps + p with its eyes; p < 0: in-step -p, whole frame -p - 1, no crops
    vec4 c = frameAt(p0 < -0.5 ? -p0 - 1.0 : steps + p0, p0 < -0.5 ? -1.0 : p0, q0, e);
    if (f > 0.001) c = mix(c, frameAt(p1 < -0.5 ? -p1 - 1.0 : steps + p1, p1 < -0.5 ? -1.0 : p1, q1, e), f);
    vec3 rgb = c.rgb / max(c.a, 0.0001);
    gl_FragColor = vec4(rgb * u_zoom.z, c.a);
}
