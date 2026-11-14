// Miku in close-up only (GLSL ES 1.00), from a close.only bake (tools/live2d_bake): no standing figure and no zoom,
// her head and chest all the time, one layer the close-up's size, its atlas (u_atlas, straight alpha, ETC2) laid out
// on a grid (u_grid, u_cropGrid): first the in-steps (the expressions coming on: Yandere's hands rising to her
// cheeks, Blush), then the poses, each with its eyes half shut and shut cropped to one rect (u_crop): sway left,
// upright and sway right with the expressions on, and the turn from the left to the right (u_frames.w each way). The
// driving set without them, the lean from a full lean left to right (u_drv.x each way, upright in its middle), is in
// an atlas of its own on the same grid (u_leanAtlas, its crops from u_lc.z), so the close-up's keeps room for the turn.
// u_zoom = (expressions 0 .. 1, turn -1 .. 1, brightness, 1 once the atlas is there): the app brings the expressions
// on over about 0.8 s when the car has stood still for 1 s or an indicator is on, and off again as she drives on.
// At 0 she leans with the car (braking .. pulling away, the app picks the frames) and blinks; in between the in-steps play; at 1 she
// plays her idle loop (a close.idle bake, its own atlas u_idle; else upright) and turns her head toward the indicator. Two nearest baked frames are blended
// everywhere, each slid so the heads meet. The app picks the two frames and their slides (u_pk): the head-shift
// tables looked up here (u_tsh[11], u_ish[10], each in a loop over the array, as GLSL ES 1.00 indexes a fragment
// shader's uniform array) restarted the KOMBI (Custom HUD 0.1.31 and 0.1.32), the loops unrolled past what it holds.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform float u_eh;      // her eyes' closure from the app, 0 open .. 1 shut: the bake's blink (close.blink, a recording's
                         // blinks), else a blink every 2 s
uniform sampler2D u_atlas;
uniform vec2 u_atlasSize;
uniform vec4 u_zoom;     // expressions 0 .. 1, turn -1 .. 1, brightness, 1 once the atlas is there (0: draw nothing)
// the app's pick: [0] the pose pair (the lean's or the turn's chain position of its first frame, the blend to the
// next), the idle loop's (its frame now, the blend to the next); [1] their head slides, px: the pose pair's two
// frames, the idle's two (each frame's shift less the blended one, so the heads meet)
uniform vec4 u_pk[2];

uniform sampler2D u_idle; // the stopped idle loop's own atlas (a close.idle bake), laid out as u_atlas
uniform vec2 u_idleSize;
uniform vec4 u_ic[4];    // its grid, crop grid, eyes' rect (as u_cl[4 .. 6]); frames, period (s) (0 frames: no loop)
uniform sampler2D u_leanAtlas; // the lean's own atlas (the driving set), on the close-up's grid
uniform vec4 u_lc;       // its w, h, the y of its crops' first row
uniform vec4 u_cl[10];   // the bake's fixed values, as one array (cluster-render's 32 uniform names a layer)
#define u_grid u_cl[4]   // frame cell w, h, columns, pad
#define u_cropGrid u_cl[5]   // crop cell w, h, columns, y of the first row
#define u_crop u_cl[6]   // the eyes' rect in a frame, px
#define u_pose u_cl[7]   // the sway's pivot x, y (frame px), its turn at the left and right sway (rad, clockwise)
#define u_drv u_cl[8]    // the lean's steps each way (the middle, upright, is the in-steps' first)
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
// the lean's frame m (0 a full lean left .. 2 * steps a full lean right) at frame px q, its eyes eh
vec4 ltap(vec2 at, vec2 size, vec2 p) {
    if (p.x < 0.0 || p.y < 0.0 || p.x > size.x || p.y > size.y) return vec4(0.0);
    vec4 t = texture2D(u_leanAtlas, (at + p) / u_lc.xy);
    return vec4(t.rgb * t.a, t.a);
}
vec2 leanCropAt(float m) {
    float row = floor((m + 0.5) / u_cropGrid.z);
    return vec2(m - row * u_cropGrid.z, row) * u_cropGrid.xy + vec2(0.0, u_lc.z) + u_grid.w;
}
vec4 leanFrame(float m, vec2 q, float eh) {
    vec4 c = ltap(slot(m), u_frames.xy, q);
    vec2 e = q - u_crop.xy;
    if (eh > 0.001 && e.x >= 0.0 && e.y >= 0.0 && e.x <= u_crop.z && e.y <= u_crop.w) {
        e = clamp(e, vec2(0.5), u_crop.zw - 0.5);
        c = mix(c, ltap(leanCropAt(2.0 * m), u_crop.zw, e), min(1.0, eh * 2.0));              // half shut
        c = mix(c, ltap(leanCropAt(2.0 * m + 1.0), u_crop.zw, e), max(0.0, eh * 2.0 - 1.0));   // shut
    }
    return c;
}
// the idle loop's frame n at frame px q, its eyes eh
vec4 itap(vec2 at, vec2 size, vec2 p) {
    if (p.x < 0.0 || p.y < 0.0 || p.x > size.x || p.y > size.y) return vec4(0.0);
    vec4 t = texture2D(u_idle, (at + p) / u_idleSize);
    return vec4(t.rgb * t.a, t.a);
}
vec4 idleFrame(float n, vec2 q, float eh) {
    float row = floor((n + 0.5) / u_ic[0].z);
    vec4 c = itap(vec2(n - row * u_ic[0].z, row) * u_ic[0].xy + u_ic[0].w, u_frames.xy, q);
    vec2 e = q - u_ic[2].xy;
    if (eh > 0.001 && e.x >= 0.0 && e.y >= 0.0 && e.x <= u_ic[2].z && e.y <= u_ic[2].w) {
        e = clamp(e, vec2(0.5), u_ic[2].zw - 0.5);
        float m = 2.0 * n, mr = floor((m + 0.5) / u_ic[1].z);
        vec2 a0 = vec2(m - mr * u_ic[1].z, mr) * u_ic[1].xy + vec2(0.0, u_ic[1].w) + u_ic[0].w;
        float m1 = m + 1.0, mr1 = floor((m1 + 0.5) / u_ic[1].z);
        vec2 a1 = vec2(m1 - mr1 * u_ic[1].z, mr1) * u_ic[1].xy + vec2(0.0, u_ic[1].w) + u_ic[0].w;
        c = mix(c, itap(a0, u_ic[2].zw, e), min(1.0, eh * 2.0));              // half shut
        c = mix(c, itap(a1, u_ic[2].zw, e), max(0.0, eh * 2.0 - 1.0));        // shut
    }
    return c;
}
// her stopped idle now (the clock's place in the loop), its two nearest frames slid so the heads meet; without a loop
// in the bake, the upright pose
vec4 idleNow(vec2 q, float eh, float wy) {
    float n = u_ic[3].x;
    if (n < 0.5) return frameAt(u_frames.z + 1.0, 1.0, q, eh);
    // the app's frame and blend (index.js idlePick: each frame holds, then crossfades into the next)
    float i0 = u_pk[0].z, f = u_pk[0].w;
    float i1 = i0 + 1.0 > n - 0.5 ? 0.0 : i0 + 1.0;
    vec4 c = idleFrame(i0, q + vec2(u_pk[1].z * wy, 0.0), eh);
    return mix(c, idleFrame(i1, q + vec2(u_pk[1].w * wy, 0.0), eh), f);
}
// the turn's chain position j (0 .. 2 * steps; the middle is her idle): its pose
float turnPose(float j) { return j < u_frames.w ? 3.0 + j : 2.0 + j; }

void main() {
    if (u_zoom.w < 0.5) { gl_FragColor = vec4(0.0); return; }
    vec2 q = v_uv * u_frames.xy;   // frame px: the layer is the close-up's size
    float y = clamp(u_zoom.x, 0.0, 1.0), eh = clamp(u_eh, 0.0, 1.0);
    // the heads meet above the shoulders: the slide fades out below the sway's pivot
    float wy = 1.0 - smoothstep(u_pose.y - 20.0, u_pose.y + 30.0, q.y);
    // every case blends two endpoints: pose p0 at q0 and p1 at q1 by f, or her idle now in place of either (idle0,
    // idle1); a pose is whole frame steps + p with crop pair p, the in-steps whole frames 0 .. steps - 1 (pose -1 - n)
    float steps = u_frames.z, p0 = 0.0, p1 = 0.0, f = 0.0, e = eh;
    bool idle0 = false, idle1 = false, lean0 = false, lean1 = false;
    vec2 q0 = q, q1 = q;
    if (y < 0.001) {
        // driving: the lean's two nearest frames (the app's pick), slid so the heads meet
        f = u_pk[0].y;
        lean0 = true;
        lean1 = true;
        p0 = u_pk[0].x;
        p1 = p0 + 1.0;
        q0 = q + vec2(u_pk[1].x * wy, 0.0);
        q1 = q + vec2(u_pk[1].y * wy, 0.0);
    } else if (y < 0.999) {
        // the expressions coming on or going off: driving upright, the in-steps, her idle; no blink meanwhile
        float k = y * (steps + 1.0), i0 = min(floor(k), steps);
        f = k - i0;
        lean0 = i0 < 0.5;   // driving upright: the lean's middle frame
        p0 = lean0 ? u_drv.x : -i0;
        idle1 = i0 + 1.0 > steps + 0.5;
        p1 = -(i0 + 1.0);
        e = 0.0;
    } else {
        // stopped (or an indicator on): her idle, and toward the indicator the turn, from wherever the idle has her
        float turn = clamp(u_zoom.y, -1.0, 1.0);
        if (abs(turn) < 0.001) idle0 = true;
        else {
            // the turn's two nearest frames (the app's pick)
            float t0 = u_pk[0].x, t1 = t0 + 1.0;
            f = u_pk[0].y;
            idle0 = abs(t0 - u_frames.w) < 0.5;
            idle1 = abs(t1 - u_frames.w) < 0.5;
            p0 = turnPose(t0);
            p1 = turnPose(t1);
            q0 = q + vec2(u_pk[1].x * wy, 0.0);
            q1 = q + vec2(u_pk[1].y * wy, 0.0);
        }
    }
    vec4 ic = vec4(0.0);
    if (idle0 || (idle1 && f > 0.001)) ic = idleNow(q, e, wy);
    // a lean endpoint: the lean's frame p; else pose p >= 0: whole frame steps + p with its eyes; p < 0: in-step -p,
    // whole frame -p - 1, no crops
    vec4 c = idle0 ? ic : lean0 ? leanFrame(p0, q0, e)
                                : frameAt(p0 < -0.5 ? -p0 - 1.0 : steps + p0, p0 < -0.5 ? -1.0 : p0, q0, e);
    if (f > 0.001)
        c = mix(c, idle1 ? ic : lean1 ? leanFrame(p1, q1, e)
                                      : frameAt(p1 < -0.5 ? -p1 - 1.0 : steps + p1, p1 < -0.5 ? -1.0 : p1, q1, e), f);
    vec3 rgb = c.rgb / max(c.a, 0.0001);
    gl_FragColor = vec4(rgb * u_zoom.z, c.a);
}
