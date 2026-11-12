// The Miku layout's character (GLSL ES 1.00), from frames baked offline (tools/live2d_bake) into one ETC2 RGBA atlas
// asset (u_atlas, straight alpha, u_atlasSize px; its tables in an RGBA8 one, u_table). She stands, as on a bus: the bake posed her at u_counts.x lean angles
// (11) with the model's own body and head rotation, from a full lean left with the braking face to a full lean right
// with the happy face (a forward/back bake: toward you braking, back pulling away), close enough together
// that the shader can blend the two nearest to u_drive.x without a double image (-1 hard braking .. +1 pulling away
// hard; the app eases it toward the g, so she straightens when the car settles without swaying past upright). Upright
// she blinks
// (idle -> half -> shut, eased) and now and then smiles as if talking. The twin tails are their own sprite: a wave runs
// down them and speed blows them out. The upper body breathes (a slight stretch above the waist). Nothing is uploaded
// after the atlas; she is animated on the renderer's clock (u_time). u_drive = (lean, speed, point, brightness): point
// -1 .. 1 raises the arm on that side to point toward the indicator (the arms are their own sprites).
// u_zoom = (zoom, the first zoom step, 0, 0): stopped, the app ramps zoom 0 .. 1 and the camera zooms in on her
// (camera()); she fades out by the first of the close-up layer's zoom steps, which takes over from there.
// The per-frame tables (lean frames, head shifts) are pixel rows under the atlas art (dat, sprite.js mikuData), not
// uniforms, and nothing loops: the cluster's GPU restarted on 0.1.9 .. 0.1.12's 55 uniform vectors and unrolled loops,
// then on 38 texture reads.
// MIKU_BARE leaves out all but the lean.
// Positions are in frame px; u_origin is where the frame's top-left sits in the layer. v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_time;
uniform vec4 u_drive;
uniform sampler2D u_atlas;
uniform sampler2D u_table;   // the per-frame tables (mikuData in sprite.js): exact values, so RGBA8 beside the ETC2 art
uniform vec2 u_atlasSize;   // the atlas and its table rows under it (px)
uniform vec2 u_frame;       // frame w, h
uniform vec2 u_origin;      // the frame's top-left in layer px
uniform vec4 u_hip;         // waist y, head y (frame px), breathing 0..1, 0
uniform vec4 u_armSide;     // x, y: arm 0's and arm 1's side (-1 left, 1 right); z: how far a pointing arm swings up (rad);
                            // w: how far the arm away from the lean swings up and out at a full lean to balance her (rad)
uniform vec4 u_zoom;        // zoom 0 .. 1, the close-up's first zoom step (0 .. 1 of the eased zoom), 0, 0
uniform vec4 u_close;       // the close-up's view, x, y, w, h in frame px
uniform vec4 u_first;       // the close-up's first zoom step's view, frame px: she fades only where it takes over

uniform vec4 u_spr[6];   // cluster-render takes at most 32 uniform names a layer, u_time among them: these fixed values go up as one array
#define u_fA u_spr[0]   // idle.xy, half.xy (atlas px of each frame's top-left)
#define u_fB u_spr[1]   // shut.xy, talk.xy
#define u_tails u_spr[2]   // atlas rect of the tails sprite (w = 0: none)
#define u_tailsAt u_spr[3]   // its top-left in frame px, root y in the sprite, length px
#define u_crop u_spr[4]   // the face frames are crops of this rect (frame px; w = 0: whole frames)
#define u_counts u_spr[5]   // lean frames (odd, up to 15), 0, 0, and the table asset's height (px; its width is the atlas's)
uniform vec4 u_arm[8];   // cluster-render takes at most 32 uniform names a layer, u_time among them: these fixed values go up as one array
#define u_arm0 u_arm[0]   // atlas rect of an arm sprite (w = 0: none)
#define u_arm0At u_arm[1]   // its top-left and its shoulder (the pivot), frame px, at rest
#define u_arm0L u_arm[2]   // at a full lean left: the shoulder's move (px) and the arm's turn (rad, the lean's own sway)
#define u_arm0R u_arm[3]   // the same at a full lean right
#define u_arm1 u_arm[4]
#define u_arm1At u_arm[5]
#define u_arm1L u_arm[6]
#define u_arm1R u_arm[7]

// a sprite pixel: atlas rect r, point p in sprite px; premultiplied; transparent outside the rect
vec4 tap(vec4 r, vec2 p) {
    if (p.x < 0.0 || p.y < 0.0 || p.x > r.z || p.y > r.w) return vec4(0.0);
    vec4 t = texture2D(u_atlas, (r.xy + p) / u_atlasSize);
    return vec4(t.rgb * t.a, t.a);
}
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
// a face frame at atlas px "at": inside the crop rect its own pixels, idle's round it (an older bake's whole frames
// when there is no crop)
vec4 cropTap(vec2 at, vec2 fb, vec4 idle) {
    if (u_crop.z <= 0.0) return tap(vec4(at, u_frame), fb);
    vec2 q = fb - u_crop.xy;
    if (q.x < 1.5 || q.y < 1.5 && u_crop.y > 0.5 || q.x > u_crop.z - 1.5 || q.y > u_crop.w - 1.5) return idle;
    return tap(vec4(at, u_crop.zw), q);
}
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
#include "camera.glsl"

// an arm: carried and turned with her lean (as the bake measured it), swung up and out from the shoulder to balance
// her (the arm away from the lean the most, the other a third as far), and by "raise" (0..1, the indicator on its
// side) to point that way. Frame px, y down
vec4 arm(vec4 r, vec4 at, vec4 offL, vec4 offR, float side, float l, float raise, vec2 p) {
    if (r.z <= 0.0) return vec4(0.0);
    vec3 off = l >= 0.0 ? offR.xyz * l : offL.xyz * -l;
    bool far = (l > 0.0 && side < 0.0) || (l < 0.0 && side > 0.0);
    float balance = u_armSide.w * abs(l) * (far ? 1.0 : 0.33);
    float phi = off.z - side * smin(u_armSide.z * raise + balance, 1.48, 0.35);   // together at most 85 deg, eased into
    vec2 sh = at.zw + off.xy;
    return tap(r, at.zw + rot(p - sh, -phi) - at.xy);
}

// table entry i (mikuData in sprite.js): a 3x3 px block of the table asset (u_table), read at its middle, two values of
// 12 bits ((v + 1024) * 2: R and B's high nibble, G and B's low nibble), -1024 .. 1023.5 px
vec2 dat(float i) {
    float per = floor(u_atlasSize.x / 3.0), row = floor(i / per), col = i - row * per;
    vec3 t = floor(texture2D(u_table, vec2(col * 3.0 + 1.5, row * 3.0 + 1.5) / vec2(u_atlasSize.x, u_counts.w)).rgb * 255.0 + 0.5);
    float lo = floor(t.b / 16.0);
    return vec2(t.r * 16.0 + lo, t.g * 16.0 + (t.b - lo * 16.0)) * 0.5 - 1024.0;
}
// the body at lean angle i (0 .. leanN - 1); the middle one is upright, with the blink and the talking smile
vec4 leanAt(float i, vec2 fb, vec4 upright) {
    if (abs(i - (u_counts.x - 1.0) * 0.5) < 0.5) return upright;
    return tap(vec4(dat(i), u_frame), fb);
}

void main() {
    // the zoom: the camera moves in on her as she fades, gone by the close-up's first zoom step
    float z = smoothstep(0.0, 1.0, clamp(u_zoom.x, 0.0, 1.0));
    if (u_close.w > 0.0 && z >= u_zoom.y) { gl_FragColor = vec4(0.0); return; }
    vec4 view = u_close.w > 0.0 ? camera(z, vec4(-u_origin, u_size), u_close) : vec4(-u_origin, u_size);
    vec2 f = view.xy + v_uv * view.zw;              // frame px
    // fading as the first zoom step comes in over her, softly at its edges (past them it has nothing to show)
    vec2 inF = min(f - u_first.xy, u_first.xy + u_first.zw - f);
    float fade = u_close.w > 0.0
        ? 1.0 - clamp(z / max(0.01, u_zoom.y), 0.0, 1.0) * smoothstep(0.0, 8.0, min(inF.x, inF.y)) : 1.0;
    float t = mod(u_time, 1200.0);
    float spd = clamp(u_drive.y, 0.0, 1.0);
    float lean = clamp(u_drive.x, -1.0, 1.0), sway = 0.05 * sin(t * 0.8);
    float brake = max(0.0, -lean);
    // breathing: a slight stretch above the waist
    float hipY = u_hip.x, up = max(0.0, hipY - f.y);
    vec2 fb = f;
    if (f.y < hipY) fb.y = hipY - up / (1.0 + 0.008 * sin(t * 1.7) * u_hip.z);

    // upright: idle -> half -> shut as the blink runs, eased; the talking smile fades over it
    float bt = mod(t, 4.6), bt2 = mod(t + 1.9, 12.0);
    float blink = smoothstep(0.0, 0.07, bt) * (1.0 - smoothstep(0.1, 0.24, bt))
        + smoothstep(0.25, 0.31, bt2) * (1.0 - smoothstep(0.34, 0.46, bt2));
    vec4 cIdle = tap(vec4(u_fA.xy, u_frame), fb);
#ifdef MIKU_BARE
    vec4 upright = cIdle;
#else
    // the half-shut and shut frames read only while she blinks (about 7% of the time), the shut one only past half
    vec4 upright = cIdle;
    if (blink > 0.001) {
        vec4 cHalf = cropTap(u_fA.zw, fb, cIdle);
        upright = blink < 0.5 ? mix(cIdle, cHalf, blink * 2.0)
            : mix(cHalf, cropTap(u_fB.xy, fb, cIdle), blink * 2.0 - 1.0);
    }
    float talk = smoothstep(0.85, 1.0, sin(t * 0.37)) * (1.0 - smoothstep(0.0, 0.3, abs(lean)));
    if (talk > 0.001) upright = mix(upright, cropTap(u_fB.zw, fb, cIdle), talk);
#endif

    // the lean: blend the two nearest baked angles (a small idle sway keeps her alive at a standstill)
    float last = max(1.0, u_counts.x - 1.0);
    float k = clamp((lean + sway + 1.0) * 0.5 * last, 0.0, last);
    float i0 = min(floor(k), last - 1.0), fr = k - i0;   // linear: an eased blend would pause at every baked angle
    float i1 = i0 + 1.0;
    vec4 c = u_counts.x < 2.5 ? upright : mix(leanAt(i0, fb, upright), leanAt(i1, fb, upright), fr);
    vec2 sh0 = dat(16.0 + i0), sh1 = dat(16.0 + i1);   // head shifts at the two angles
    // the arms, in front: u_drive.z points (-1 the left arm out to the left .. 1 the right arm out to the right)
    float le = clamp(lean + sway, -1.0, 1.0), pt = clamp(u_drive.z, -1.0, 1.0);
    float r0 = u_armSide.x < 0.0 ? max(0.0, -pt) : max(0.0, pt), r1 = u_armSide.y < 0.0 ? max(0.0, -pt) : max(0.0, pt);
#ifndef MIKU_BARE
    c = over(arm(u_arm0, u_arm0At, u_arm0L, u_arm0R, u_armSide.x, le, r0, fb), c);
    c = over(arm(u_arm1, u_arm1At, u_arm1L, u_arm1R, u_armSide.y, le, r1, fb), c);
#endif

    // twin tails, behind. They hang from her head, so they move with it as she leans (the ends trailing a little);
    // a wave runs down them, faster and wider with speed, and the wind spreads them out and lifts them
#ifndef MIKU_BARE
    if (u_tails.z > 0.0) {
        vec2 tp = f - u_tailsAt.xy;
        float w = clamp((tp.y - u_tailsAt.z) / max(1.0, u_tailsAt.w), 0.0, 1.0);
        float head = u_counts.x < 2.5 ? 0.0 : mix(sh0.x, sh1.x, fr);
        tp.y -= u_counts.x < 2.5 ? 0.0 : mix(sh0.y, sh1.y, fr);   // y: the forward/back lean's head drop
        // each tail swings out on its own side, fading to nothing across the middle (a hard split would tear it)
        float side = clamp((tp.x - u_tails.z * 0.5) / (u_tails.z * 0.25), -1.0, 1.0);
        float wave = sin(t * 1.6 - w * 2.4) * 2.5 * (1.0 - spd)
            + (sin(t * 6.0 - w * 4.0) * 3.0 + sin(t * 10.3 + 1.3 - w * 5.0) * 1.5) * spd;
        float spread = side * (spd * 22.0 + brake * 6.0) * pow(w, 1.4);
        tp.x -= head * (1.0 - 0.35 * w) + (wave + spread) * w;
        tp.y += spd * 14.0 * w * w;                            // lifted by the wind
        c = over(c, tap(u_tails, tp));
    }
#endif

    c *= fade;
    vec3 rgb = c.rgb / max(c.a, 0.0001);
    gl_FragColor = vec4(rgb * u_drive.w, c.a);
}
