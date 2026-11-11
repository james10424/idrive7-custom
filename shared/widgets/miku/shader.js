"use strict";
/** The Miku character's fragment shader (GLSL ES 1.00) for her cluster-render effect layer; index.js sends its uniforms. */
const MIKU = `// The Miku layout's character (GLSL ES 1.00), from frames baked offline (tools/live2d_bake) into one RGBA atlas
// asset (u_atlas, straight alpha, u_atlasSize px). She stands, as on a bus: the bake posed her at u_counts.x lean angles
// (11) with the model's own body and head rotation, from a full lean left with the braking face to a full lean right
// with the happy face (a forward/back bake: toward you braking, back pulling away), close enough together
// that the shader can blend the two nearest to u_drive.x without a double image (-1 hard braking .. +1 pulling away
// hard; the app eases it toward the g, so she straightens when the car settles without swaying past upright). Upright
// she blinks
// (idle -> half -> shut, eased) and now and then smiles as if talking. The twin tails are their own sprite: a wave runs
// down them and speed blows them out. The upper body breathes (a slight stretch above the waist). Nothing is uploaded
// after the atlas; she is animated on the renderer's clock (u_time). u_drive = (lean, speed, point, brightness): point
// -1 .. 1 raises the arm on that side to point toward the indicator (the arms are their own sprites).
// u_idle = (look, doze, glance frames, doze frames): while the car idles she glances around (look -1 .. 1 blends the
// baked glances, head and eyes, the same way as the lean) and, stopped a while, dozes off (doze 0 .. 1: eyes half
// shut, shut, then the head drooping over the doze frames). Either takes over from the lean, which fades out under it.
// The per-frame tables (lean, glance and doze frames, head shifts) are pixel rows under the atlas art (dat,
// hud.js mikuData), not uniforms, and nothing loops: the cluster's GPU restarted on 0.1.9 .. 0.1.12's 55 uniform
// vectors and unrolled loops; then on legs and glances together (each alone ran). The limits are per shader (Nov 10
// 2026), so she is drawn by three layers stacked, each this source with one part defined, every one sent the same
// pose uniforms in the same tick: MIKU_BACK the tails and the legs, MIKU_MID the body (lean blend, blink, glances,
// doze), MIKU_FRONT the arms.
// The legs are their own sprites (the bake leaves them out of the body frames): the hips go where the lean frames put
// them (hip shift table), each thigh turns at the hip and each shin at the knee to put the ankle where the foot is.
// u_step = (gait, stride px, press 0..1, 0): a full lean held topples her: she stumbles sideways in shuffles (the foot
// on that side steps out, the other follows; gait 0 .. 2 x shuffles, one foot a unit, stride px a shuffle, its sign
// the way she goes), the whole figure sliding over the planted feet, until she is pressed against a wall (press);
// walking back runs the gait backwards. The app moves the gait; all three layers move as one.
// MIKU_NO_IDLE (the layout's "idle": false) leaves the glances and dozing out, MIKU_BARE all but the lean.
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
uniform vec2 u_atlasSize;   // the atlas and its table rows under it (px)
uniform vec2 u_frame;       // frame w, h
uniform vec2 u_origin;      // the frame's top-left in layer px
uniform vec4 u_hip;         // waist y, head y (frame px), breathing 0..1, 0
uniform vec4 u_idle;        // look -1 .. 1, doze 0 .. 1, 0, 0
uniform vec4 u_step;        // gait 0 .. 2 x shuffles, stride px (signed: the way she goes), press 0..1, 0

uniform vec4 u_spr[6];   // cluster-render takes at most 32 uniform names a layer, u_time among them: these fixed values go up as one array
#define u_fA u_spr[0]   // idle.xy, half.xy (atlas px of each frame's top-left)
#define u_fB u_spr[1]   // shut.xy, talk.xy
#define u_tails u_spr[2]   // atlas rect of the tails sprite (w = 0: none)
#define u_tailsAt u_spr[3]   // its top-left in frame px, root y in the sprite, length px
#define u_crop u_spr[4]   // the face, glance and doze frames are crops of this rect (frame px; w = 0: whole frames)
#define u_counts u_spr[5]   // lean frames (odd, up to 15), glance frames (odd, up to 7, the middle idle), doze frames
                            // (up to 4), and the y of the table rows in the atlas
#ifdef MIKU_FRONT
uniform vec4 u_armSide;     // x, y: arm 0's and arm 1's side (-1 left, 1 right); z: how far a pointing arm swings up (rad);
                            // w: how far the arm away from the lean swings up and out at a full lean to balance her (rad)
uniform vec4 u_arm[8];   // cluster-render takes at most 32 uniform names a layer, u_time among them: these fixed values go up as one array
#define u_arm0 u_arm[0]   // atlas rect of an arm sprite (w = 0: none)
#define u_arm0At u_arm[1]   // its top-left and its shoulder (the pivot), frame px, at rest
#define u_arm0L u_arm[2]   // at a full lean left: the shoulder's move (px) and the arm's turn (rad, the lean's own sway)
#define u_arm0R u_arm[3]   // the same at a full lean right
#define u_arm1 u_arm[4]
#define u_arm1At u_arm[5]
#define u_arm1L u_arm[6]
#define u_arm1R u_arm[7]
#endif
#ifdef MIKU_BACK
uniform vec4 u_leg[6];   // the legs' fixed values as one array
#define u_leg0 u_leg[0]   // atlas rect of a leg sprite (w = 0: none)
#define u_leg0A u_leg[1]   // its top-left and its hip (frame px, at rest)
#define u_leg0B u_leg[2]   // its knee and ankle (frame px, at rest)
#define u_leg1 u_leg[3]
#define u_leg1A u_leg[4]
#define u_leg1B u_leg[5]
#endif

// a sprite pixel: atlas rect r, point p in sprite px; premultiplied; transparent outside the rect
vec4 tap(vec4 r, vec2 p) {
    if (p.x < 0.0 || p.y < 0.0 || p.x > r.z || p.y > r.w) return vec4(0.0);
    vec4 t = texture2D(u_atlas, (r.xy + p) / u_atlasSize);
    return vec4(t.rgb * t.a, t.a);
}
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
// a face, glance or doze frame at atlas px "at": inside the crop rect its own pixels, idle's round it (an older
// bake's whole frames when there is no crop)
vec4 cropTap(vec2 at, vec2 fb, vec4 idle) {
    if (u_crop.z <= 0.0) return tap(vec4(at, u_frame), fb);
    vec2 q = fb - u_crop.xy;
    if (q.x < 1.5 || q.y < 1.5 && u_crop.y > 0.5 || q.x > u_crop.z - 1.5 || q.y > u_crop.w - 1.5) return idle;
    return tap(vec4(at, u_crop.zw), q);
}
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

#ifdef MIKU_FRONT
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
#endif

// table entry i (mikuData in hud.js): a 3x3 px block in the rows under the art, read at its middle, two values of
// 12 bits ((v + 1024) * 2: R and B's high nibble, G and B's low nibble), -1024 .. 1023.5 px
vec2 dat(float i) {
    float per = floor(u_atlasSize.x / 3.0), row = floor(i / per), col = i - row * per;
    vec3 t = floor(texture2D(u_atlas, vec2(col * 3.0 + 1.5, u_counts.w + row * 3.0 + 1.5) / u_atlasSize).rgb * 255.0 + 0.5);
    float lo = floor(t.b / 16.0);
    return vec2(t.r * 16.0 + lo, t.g * 16.0 + (t.b - lo * 16.0)) * 0.5 - 1024.0;
}
#ifdef MIKU_MID
// the body at lean angle i (0 .. leanN - 1); the middle one is upright, with the blink and the talking smile
vec4 leanAt(float i, vec2 fb, vec4 upright) {
    if (abs(i - (u_counts.x - 1.0) * 0.5) < 0.5) return upright;
    return tap(vec4(dat(i), u_frame), fb);
}
#endif
#ifdef MIKU_BACK
// the angle that turns a straight-down vector onto v (rot's sense)
float ang(vec2 v) { return atan(-v.x, v.y); }
// a leg: the hip moved by hm and the ankle by am (frame px against rest). The whole leg turns at the hip toward the
// ankle; where the ankle is nearer than the leg is long, the knee bends outward (side) so thigh and shin still meet.
// The foot (below the ankle) is carried level; the thigh fades into the shin over a few px past the knee and the
// foot is drawn over the shin's end, so the joints show no seam
vec4 leg(vec4 r, vec4 A, vec4 B, float side, vec2 hm, vec2 am, vec2 p) {
    if (r.z <= 0.0) return vec4(0.0);
    vec2 hip0 = A.zw, knee0 = B.xy, ank0 = B.zw;
    vec2 d0 = ank0 - hip0, hip = hip0 + hm, d = ank0 + am - hip;
    float len0 = length(d0), phi = ang(d) - ang(d0);
    float th = 2.0 * acos(clamp(length(d) / max(1.0, len0), 0.0, 1.0));
    float a = phi - side * th * 0.5, b = phi + side * th * 0.5;
    vec2 knee = hip + rot(knee0 - hip0, a), ank = knee + rot(ank0 - knee0, b);
    vec4 c = vec4(0.0);
    vec2 qs = ank0 + rot(p - ank, -b);
    if (qs.y >= knee0.y - 6.0 && qs.y <= ank0.y + 2.0) c = tap(r, qs - A.xy);
    vec2 qf = p - ank + ank0;
    if (qf.y >= ank0.y) c = over(tap(r, qf - A.xy), c);
    vec2 qt = hip0 + rot(p - hip, -a);
    float wt = 1.0 - smoothstep(knee0.y - 4.0, knee0.y + 4.0, qt.y);
    if (wt > 0.0) c = over(tap(r, qt - A.xy) * wt, c);
    return c;
}
#endif

void main() {
    vec2 px = vec2(v_uv.x * u_size.x, v_uv.y * u_size.y);
    float t = mod(u_time, 1200.0);
    // the stumble: gait g runs over the shuffles, the foot on her way (lead) stepping out in the first half of each
    // and the other (trail) following in the second, each lifted on its way; the body rides between them, bobbing
    // up a little at each step, and presses a few px into the wall at the end
    float g = max(0.0, u_step.x), s = abs(u_step.y), dir = u_step.y < 0.0 ? -1.0 : 1.0;
    float full = floor(g * 0.5), r = g - 2.0 * full;
    float uL = clamp(r, 0.0, 1.0), uT = clamp(r - 1.0, 0.0, 1.0);
    float lead = s * (full + smoothstep(0.0, 1.0, uL)), trail = s * (full + smoothstep(0.0, 1.0, uT));
    float liftL = sin(3.14159 * uL), liftT = sin(3.14159 * uT);
    vec2 body = vec2(dir * ((lead + trail) * 0.5 + 2.0 * clamp(u_step.z, 0.0, 1.0)), -1.5 * (liftL + liftT));
    vec2 f0 = px - u_origin;                        // frame px, where she stands
    vec2 f = f0 - body;                             // frame px, as her body has moved
    float spd = clamp(u_drive.y, 0.0, 1.0);
    // a glance or a doze takes over from the lean (the app starts either only while the car idles, lean about 0)
    float look = clamp(u_idle.x, -1.0, 1.0), doze = clamp(u_idle.y, 0.0, 1.0);
    float lookN = u_counts.y, dozeN = u_counts.z;
    if (lookN < 2.5) look = 0.0;
#ifdef MIKU_NO_IDLE
    look = 0.0; doze = 0.0;
#endif
    float calm = 1.0 - smoothstep(0.0, 0.3, max(abs(look), doze));
    float lean = clamp(u_drive.x, -1.0, 1.0) * calm, sway = 0.05 * sin(t * 0.8) * calm;
    float brake = max(0.0, -lean);
    // breathing: a slight stretch above the waist
    float hipY = u_hip.x, up = max(0.0, hipY - f.y);
    vec2 fb = f;
    if (f.y < hipY) fb.y = hipY - up / (1.0 + 0.008 * sin(t * 1.7) * u_hip.z);
    // the lean: the two nearest baked angles (a small idle sway keeps her alive at a standstill)
    float last = max(1.0, u_counts.x - 1.0);
    float k = clamp((lean + sway + 1.0) * 0.5 * last, 0.0, last);
    float i0 = min(floor(k), last - 1.0), fr = k - i0;   // linear: an eased blend would pause at every baked angle
    float i1 = i0 + 1.0;
    vec4 c = vec4(0.0);

#ifdef MIKU_MID
    // upright: idle -> half -> shut as the blink runs, eased; the talking smile fades over it
    float bt = mod(t, 4.6), bt2 = mod(t + 1.9, 12.0);
    float blink = smoothstep(0.0, 0.07, bt) * (1.0 - smoothstep(0.1, 0.24, bt))
        + smoothstep(0.25, 0.31, bt2) * (1.0 - smoothstep(0.34, 0.46, bt2));
    vec4 cIdle = tap(vec4(u_fA.xy, u_frame), fb);
#ifdef MIKU_BARE
    vec4 upright = cIdle;
#else
    vec4 cHalf = cropTap(u_fA.zw, fb, cIdle), cShut = cropTap(u_fB.xy, fb, cIdle);
    vec4 upright = blink < 0.5 ? mix(cIdle, cHalf, blink * 2.0) : mix(cHalf, cShut, blink * 2.0 - 1.0);
    float talk = smoothstep(0.85, 1.0, sin(t * 0.37)) * (1.0 - smoothstep(0.0, 0.3, abs(lean))) * calm;
    if (talk > 0.001) upright = mix(upright, cropTap(u_fB.zw, fb, cIdle), talk);
#endif
    // glancing: the two nearest baked glances, the middle one being upright (blinking) itself
    float lookMid = (lookN - 1.0) * 0.5;
#ifndef MIKU_NO_IDLE
    if (look != 0.0) {
        float lk = (look + 1.0) * lookMid, j0 = min(floor(lk), lookN - 2.0), lf = lk - j0;
        vec4 a = abs(j0 - lookMid) < 0.5 ? upright : cropTap(dat(32.0 + j0), fb, cIdle);
        vec4 b = abs(j0 + 1.0 - lookMid) < 0.5 ? upright : cropTap(dat(33.0 + j0), fb, cIdle);
        upright = mix(a, b, lf);
    }
    // dozing: upright -> half -> shut -> the doze frames, the two nearest blended
    if (doze > 0.0) {
        float dk = doze * (2.0 + dozeN), d0 = min(floor(dk), 1.0 + dozeN), df = dk - d0, d1 = d0 + 1.0;
        vec4 a = d0 < 0.5 ? upright : d0 < 1.5 ? cHalf : d0 < 2.5 ? cShut : cropTap(dat(45.0 + d0), fb, cIdle);
        vec4 b = d1 < 1.5 ? cHalf : d1 < 2.5 ? cShut : cropTap(dat(45.0 + d1), fb, cIdle);
        upright = mix(a, b, df);
    }
#endif
    c = u_counts.x < 2.5 ? upright : mix(leanAt(i0, fb, upright), leanAt(i1, fb, upright), fr);
#endif

#ifdef MIKU_FRONT
    // the arms: u_drive.z points (-1 the left arm out to the left .. 1 the right arm out to the right)
    float le = clamp(lean + sway, -1.0, 1.0), pt = clamp(u_drive.z, -1.0, 1.0);
    float r0 = u_armSide.x < 0.0 ? max(0.0, -pt) : max(0.0, pt), r1 = u_armSide.y < 0.0 ? max(0.0, -pt) : max(0.0, pt);
#ifndef MIKU_BARE
    c = over(arm(u_arm0, u_arm0At, u_arm0L, u_arm0R, u_armSide.x, le, r0, fb), c);
    c = over(arm(u_arm1, u_arm1At, u_arm1L, u_arm1R, u_armSide.y, le, r1, fb), c);
#endif
#endif

#ifdef MIKU_BACK
    // twin tails, behind everything. They hang from her head, so they move with it as she leans (the ends trailing a
    // little); a wave runs down them, faster and wider with speed, and the wind spreads them out and lifts them
#ifndef MIKU_BARE
    if (u_tails.z > 0.0) {
        vec2 sh0 = dat(16.0 + i0), sh1 = dat(16.0 + i1);   // head shifts at the two angles
        float lookHead = 0.0;
        vec2 dozeHead = vec2(0.0);
#ifndef MIKU_NO_IDLE
        if (look != 0.0) {
            float lookMid = (lookN - 1.0) * 0.5, lk = (look + 1.0) * lookMid, j0 = min(floor(lk), lookN - 2.0);
            lookHead = mix(dat(40.0 + j0).x, dat(41.0 + j0).x, lk - j0);
        }
        if (doze > 0.0) {
            float dk = doze * (2.0 + dozeN), d0 = min(floor(dk), 1.0 + dozeN), d1 = d0 + 1.0;
            dozeHead = mix(d0 < 2.5 ? vec2(0.0) : dat(49.0 + d0), d1 < 2.5 ? vec2(0.0) : dat(49.0 + d1), dk - d0);
        }
#endif
        vec2 tp = f - u_tailsAt.xy;
        float w = clamp((tp.y - u_tailsAt.z) / max(1.0, u_tailsAt.w), 0.0, 1.0);
        float head = (u_counts.x < 2.5 ? 0.0 : mix(sh0.x, sh1.x, fr)) + lookHead + dozeHead.x;
        tp.y -= dozeHead.y + (u_counts.x < 2.5 ? 0.0 : mix(sh0.y, sh1.y, fr));   // y: the forward/back lean's head drop
        // each tail swings out on its own side, fading to nothing across the middle (a hard split would tear it)
        float side = clamp((tp.x - u_tails.z * 0.5) / (u_tails.z * 0.25), -1.0, 1.0);
        float wave = sin(t * 1.6 - w * 2.4) * 2.5 * (1.0 - spd)
            + (sin(t * 6.0 - w * 4.0) * 3.0 + sin(t * 10.3 + 1.3 - w * 5.0) * 1.5) * spd;
        float spread = side * (spd * 22.0 + brake * 6.0) * pow(w, 1.4);
        tp.x -= head * (1.0 - 0.35 * w) + (wave + spread) * w;
        tp.y += spd * 14.0 * w * w;                            // lifted by the wind
        c = tap(u_tails, tp);
    }
#endif
    // the legs, over the tails (under the body, the next layer up): hips where the lean frames put them and as her
    // body has moved; feet planted where the gait has them, the swinging one lifted
    if (u_leg0.z > 0.0 || u_leg1.z > 0.0) {
        vec2 hm = body + vec2(u_counts.x < 2.5 ? 0.0 : mix(dat(56.0 + i0).x, dat(56.0 + i1).x, fr), 0.0);
        float side0 = u_leg0A.z < u_frame.x * 0.5 ? -1.0 : 1.0, side1 = u_leg1A.z < u_frame.x * 0.5 ? -1.0 : 1.0;
        // the leg on her way leads
        vec2 a0 = side0 == dir ? vec2(dir * lead, -6.0 * liftL) : vec2(dir * trail, -6.0 * liftT);
        vec2 a1 = side1 == dir ? vec2(dir * lead, -6.0 * liftL) : vec2(dir * trail, -6.0 * liftT);
        if (s <= 0.0) { a0 = vec2(0.0); a1 = vec2(0.0); }
        c = over(leg(u_leg0, u_leg0A, u_leg0B, side0, hm, a0, f0), c);
        c = over(leg(u_leg1, u_leg1A, u_leg1B, side1, hm, a1, f0), c);
    }
#endif

    vec3 rgb = c.rgb / max(c.a, 0.0001);
    gl_FragColor = vec4(rgb * u_drive.w, c.a);
}
`;

module.exports = MIKU;
