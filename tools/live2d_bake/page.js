'use strict';
/* Perch bake page (served by serve.js). A small WebGL renderer on Live2D's Cubism Core: drawables in render order,
 * clipping masks through the stencil buffer, normal / additive / multiplicative blending, multiply and screen colours.
 * No physics: the model is posed by parameters only, and the HUD's shader adds the motion.
 *
 * CONFIG (the --config file, kept next to the model):
 *   params      { id: value } set on every frame (e.g. a watermark off, a toggle on)
 *   frames      { idle | half | shut | happy | brake | talk: { params: { id: value }, expressions: ["X.exp3.json"] } }
 *               each frame's own parameters, on top of "params"; missing frames reuse idle
 *   tails       ["part id", ...]: drawn in their own sprite (swung by the HUD), hidden in the body frames
 *   tailsRoot   0..1: where the tails hang from, as a fraction down the tails sprite (0.15)
 *   stand       { height: px, anchor: [fx, fy] }: the figure's height on the HUD; anchor = the point on the sign's corner,
 *               as fractions of the figure's box (0.5, 1 = between the feet)
 *   sit         { height, anchor, legs: [{ parts: ["part id"], hip: [x, y], knee: [x, y], thigh: [angle deg, length 0..1],
 *               limit: rad }, ...] (the near leg first), skirt: ["part id"] }: hip and knee in model units (see ?inspect,
 *               which prints the figure's box); each leg is cut at the knee: the thigh turns to "angle" (0 = straight
 *               down, 90 = pointing left) and shortens to "length" of itself (seen end-on), the shin hangs from the new
 *               knee in its own sprite, which the HUD swings
 *   pxPerUnit   HUD px per model unit, both poses (so she is the same size sitting and standing)
 *   waist       model y the upper body breathes and sways above
 *   stand.hide / sit.hide  ["part id"]: left out of that pose entirely (e.g. long ribbons that would hang like legs)
 *   pad         px of transparent border round each sprite (2)
 * Anchors and hip / knee points are in model units (y up), as ?inspect's grid shows them; "anchor" is the model point that
 * goes on the sign's top-left corner, "anchorPx" px added to it on the HUD (right, down).
 */
const C = window.Live2DCubismCore;
const logEl = document.getElementById('log'), view = document.getElementById('view');
const log = (s) => { logEl.textContent += '\n' + s; };
const SS = 4;   // render this many times bigger than the frame, then scale down

async function json(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + ': ' + r.status); return r.json(); }

async function loadModel() {
    const m3 = await json('/model.json');
    const moc = C.Moc.fromArrayBuffer(await (await fetch('/model/' + m3.FileReferences.Moc)).arrayBuffer());
    if (!moc) throw new Error('the .moc3 did not load (Cubism Core too old for it?)');
    const model = C.Model.fromMoc(moc);
    const imgs = await Promise.all(m3.FileReferences.Textures.map((t) => new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('texture ' + t)); i.src = '/model/' + encodeURI(t);
    })));
    const cdi = m3.FileReferences.DisplayInfo ? await json('/model/' + encodeURI(m3.FileReferences.DisplayInfo)).catch(() => null) : null;
    return { m3, model, imgs, cdi };
}

/* ---------- renderer ---------- */
const VS = `attribute vec2 a_pos; attribute vec2 a_uv; attribute float a_s;
uniform vec4 u_xf; varying vec2 v_uv; varying float v_s;
void main() { gl_Position = vec4(a_pos * u_xf.xy + u_xf.zw, 0.0, 1.0); v_uv = vec2(a_uv.x, 1.0 - a_uv.y); v_s = a_s; }`;
const FS = `precision mediump float;
uniform sampler2D u_tex; uniform float u_op; uniform vec4 u_mul; uniform vec4 u_scr; uniform float u_clip; uniform float u_mask; uniform float u_leg;
varying vec2 v_uv; varying float v_s;
void main() {
    // v_s: how far down the leg (0 hip, 1 knee) plus 100 x the leg's number
    float leg = floor((v_s + 50.0) / 100.0), sl = v_s - leg * 100.0;
    if (u_clip > 0.5 && u_clip < 1.5 && sl >= 1.0) discard;               // 1: the thigh side of the knee only
    if (u_clip > 1.5 && (sl < 1.0 || abs(leg - u_leg) > 0.5)) discard;     // 2: one leg's shin only
    vec4 t = texture2D(u_tex, v_uv);
    if (u_mask > 0.5) { if (t.a < 0.5) discard; gl_FragColor = vec4(0.0); return; }
    vec3 rgb = t.rgb * u_mul.rgb;
    rgb = rgb + u_scr.rgb - rgb * u_scr.rgb;
    float a = t.a * u_op;
    gl_FragColor = vec4(rgb * a, a);
}`;

class Renderer {
    constructor(L) {
        this.L = L;
        this.canvas = document.createElement('canvas');
        const gl = this.gl = this.canvas.getContext('webgl', { stencil: true, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true, antialias: true });
        const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
        const p = this.prog = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
        gl.useProgram(p);
        this.loc = { pos: gl.getAttribLocation(p, 'a_pos'), uv: gl.getAttribLocation(p, 'a_uv'), s: gl.getAttribLocation(p, 'a_s') };
        this.u = {}; ['u_xf', 'u_tex', 'u_op', 'u_mul', 'u_scr', 'u_clip', 'u_mask', 'u_leg'].forEach((n) => { this.u[n] = gl.getUniformLocation(p, n); });
        this.bufPos = gl.createBuffer(); this.bufUv = gl.createBuffer(); this.bufS = gl.createBuffer(); this.bufIdx = gl.createBuffer();
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        this.tex = L.imgs.map((img) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        });
    }

    /* Draw the model into a w x h canvas: box [x0, y0, x1, y1] in model units fills it (y up). opts.only(i) /
     * opts.skip(i): which drawables; opts.geom(i): { pos, s, clip } replacing a drawable's vertices (sit legs). */
    draw(w, h, box, opts) {
        const gl = this.gl, d = this.L.model.drawables, o = opts || {};
        this.canvas.width = w; this.canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.useProgram(this.prog);
        gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
        const sx = 2 / (box[2] - box[0]), sy = 2 / (box[3] - box[1]);
        gl.uniform4f(this.u.u_xf, sx, sy, -1 - box[0] * sx, -1 - box[1] * sy);
        gl.uniform1i(this.u.u_tex, 0);
        const ro = this.L.model.getRenderOrders ? this.L.model.getRenderOrders() : d.renderOrders;
        const order = Array.from({ length: d.count }, (_, i) => i).sort((a, b) => ro[a] - ro[b]);
        order.forEach((i) => {
            if (!C.Utils.hasIsVisibleBit(d.dynamicFlags[i]) || d.opacities[i] <= 0.001) return;
            if (o.only && !o.only(i)) return;
            if (o.skip && o.skip(i)) return;
            const g = o.geom ? o.geom(i) : null;
            if (g && g.hide) return;
            const masks = d.masks[i], n = d.maskCounts[i];
            if (n > 0) {
                gl.enable(gl.STENCIL_TEST);
                gl.clear(gl.STENCIL_BUFFER_BIT);
                gl.colorMask(false, false, false, false);
                gl.stencilFunc(gl.ALWAYS, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
                gl.uniform1f(this.u.u_mask, 1);
                for (let k = 0; k < n; k++) this._mesh(masks[k], o.geom ? o.geom(masks[k]) : null, true);
                gl.uniform1f(this.u.u_mask, 0);
                gl.colorMask(true, true, true, true);
                const inv = C.Utils.hasIsInvertedMaskBit(d.constantFlags[i]);
                gl.stencilFunc(inv ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
            }
            const f = d.constantFlags[i];
            if (C.Utils.hasBlendAdditiveBit(f)) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
            else if (C.Utils.hasBlendMultiplicativeBit(f)) gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
            else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.uniform1f(this.u.u_op, d.opacities[i]);
            const mc = d.multiplyColors, sc = d.screenColors;
            gl.uniform4f(this.u.u_mul, mc ? mc[i * 4] : 1, mc ? mc[i * 4 + 1] : 1, mc ? mc[i * 4 + 2] : 1, 1);
            gl.uniform4f(this.u.u_scr, sc ? sc[i * 4] : 0, sc ? sc[i * 4 + 1] : 0, sc ? sc[i * 4 + 2] : 0, 0);
            this._mesh(i, g, false);
            if (n > 0) gl.disable(gl.STENCIL_TEST);
        });
        return this.canvas;
    }

    _mesh(i, g, isMask) {
        const gl = this.gl, d = this.L.model.drawables;
        const pos = g && g.pos ? g.pos : d.vertexPositions[i];
        const nv = d.vertexCounts[i];
        const s = g && g.s ? g.s : new Float32Array(nv);
        gl.uniform1f(this.u.u_clip, g && !isMask ? (g.clip || 0) : 0);
        gl.uniform1f(this.u.u_leg, g && g.leg !== undefined ? g.leg : 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex[d.textureIndices[i]]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufUv); gl.bufferData(gl.ARRAY_BUFFER, d.vertexUvs[i], gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.loc.uv); gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 0, 0);
        if (this.loc.s >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufS); gl.bufferData(gl.ARRAY_BUFFER, s, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(this.loc.s); gl.vertexAttribPointer(this.loc.s, 1, gl.FLOAT, false, 0, 0);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.indices[i], gl.DYNAMIC_DRAW);
        gl.drawElements(gl.TRIANGLES, d.indexCounts ? d.indexCounts[i] : d.indices[i].length, gl.UNSIGNED_SHORT, 0);
    }
}

/* ---------- model helpers ---------- */
function setParams(L, values) {
    const p = L.model.parameters;
    for (let i = 0; i < p.count; i++) p.values[i] = p.defaultValues[i];
    Object.keys(values || {}).forEach((id) => {
        const i = p.ids.indexOf(id);
        if (i < 0) { log('  (no parameter "' + id + '")'); return; }
        p.values[i] = Math.max(p.minimumValues[i], Math.min(p.maximumValues[i], values[id]));
    });
}
async function expressionParams(names) {
    const out = {};
    for (const n of names || []) {
        const e = await json('/model/' + encodeURI(n));
        (e.Parameters || []).forEach((q) => { out[q.Id] = (q.Blend === 'Multiply' ? (out[q.Id] || 1) * q.Value : q.Blend === 'Overwrite' ? q.Value : (out[q.Id] || 0) + q.Value); });
    }
    return out;
}
/* Is drawable i inside one of these parts (by id), at any depth? */
function inParts(L, ids) {
    const parts = L.model.parts, d = L.model.drawables, want = new Set();
    ids.forEach((id) => { const k = parts.ids.indexOf(id); if (k >= 0) want.add(k); else log('  (no part "' + id + '")'); });
    const memo = new Map();
    return (i) => {
        if (memo.has(i)) return memo.get(i);
        let k = d.parentPartIndices[i], hit = false;
        while (k >= 0 && !hit) { hit = want.has(k); k = parts.parentIndices[k]; }
        memo.set(i, hit);
        return hit;
    };
}
function bounds(L, only, geom) {
    const d = L.model.drawables;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < d.count; i++) {
        if (!C.Utils.hasIsVisibleBit(d.dynamicFlags[i]) || d.opacities[i] <= 0.001 || (only && !only(i))) continue;
        const g = geom ? geom(i) : null;
        if (g && g.hide) continue;
        const v = g && g.pos ? g.pos : d.vertexPositions[i];
        for (let k = 0; k < v.length; k += 2) {
            if (g && g.s && g.clip === 1) { const sv = g.s[k / 2]; if (sv - Math.floor((sv + 50) / 100) * 100 >= 1) continue; }
            x0 = Math.min(x0, v[k]); x1 = Math.max(x1, v[k]); y0 = Math.min(y0, v[k + 1]); y1 = Math.max(y1, v[k + 1]);
        }
    }
    return [x0, y0, x1, y1];
}

/* ---------- inspect ---------- */
async function inspect(L, cfg) {
    setParams(L, cfg.params);
    L.model.update();
    const R = new Renderer(L), d = L.model.drawables, parts = L.model.parts;
    const box = bounds(L);
    log('figure box (model units): x ' + box[0].toFixed(3) + '..' + box[2].toFixed(3) + ', y ' + box[1].toFixed(3) + '..' + box[3].toFixed(3) + ' (y up)');
    const names = {};
    (L.cdi && L.cdi.Parts || []).forEach((p) => { names[p.Id] = p.Name; });
    const H = 1000, W = Math.round(H * (box[2] - box[0]) / (box[3] - box[1]));
    const full = R.draw(W, H, box);
    const big = document.createElement('canvas'); big.className = 'big'; big.width = W; big.height = H;
    const g2 = big.getContext('2d'); g2.drawImage(full, 0, 0);
    // a grid every 0.1 model units, labelled, to read hip and knee positions off
    g2.strokeStyle = 'rgba(255,80,80,.5)'; g2.fillStyle = '#f66'; g2.font = '11px monospace';
    for (let v = Math.ceil(box[1] * 10) / 10; v <= box[3]; v += 0.1) { const y = H - (v - box[1]) / (box[3] - box[1]) * H; g2.beginPath(); g2.moveTo(0, y); g2.lineTo(W, y); g2.stroke(); g2.fillText(v.toFixed(1), 2, y - 2); }
    for (let v = Math.ceil(box[0] * 10) / 10; v <= box[2]; v += 0.1) { const x = (v - box[0]) / (box[2] - box[0]) * W; g2.beginPath(); g2.moveTo(x, 0); g2.lineTo(x, H); g2.stroke(); g2.fillText(v.toFixed(1), x + 2, 12); }
    view.appendChild(big);
    // every part with drawables of its own, alone
    const grid = document.createElement('div'); grid.className = 'grid'; view.appendChild(grid);
    for (let k = 0; k < parts.count; k++) {
        const only = inParts(L, [parts.ids[k]]);
        let any = false;
        for (let i = 0; i < d.count && !any; i++) any = only(i) && C.Utils.hasIsVisibleBit(d.dynamicFlags[i]) && d.opacities[i] > 0.001;
        if (!any) continue;
        const c = document.createElement('div'); c.className = 'cell';
        const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
        const img = R.draw(128, 128, [box[0], box[1], box[0] + (box[3] - box[1]), box[3]], { only });
        cv.getContext('2d').drawImage(img, 0, 0);
        c.appendChild(cv);
        c.appendChild(document.createTextNode(parts.ids[k] + ' ' + (names[parts.ids[k]] || '')));
        grid.appendChild(c);
    }
    log('parts shown: ' + grid.children.length + ' of ' + parts.count);
}

/* ---------- bake ---------- */
// Scale a canvas down to w x h in halving steps (a single big step aliases)
function shrink(src, w, h) {
    let c = src;
    while (c.width / 2 >= w * 1.01) {
        const n = document.createElement('canvas'); n.width = Math.round(c.width / 2); n.height = Math.round(c.height / 2);
        const g = n.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, n.width, n.height); c = n;
    }
    const n = document.createElement('canvas'); n.width = w; n.height = h;
    const g = n.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, w, h);
    return n;
}
function alphaBox(cv) {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 2) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/* The sit pose: each leg's vertices bent at the knee. Every vertex of the legs' parts (and of any drawable lying
 * wholly below "below", such as a shoe's decoration) goes with the leg whose hip is nearest in x; s per vertex is 0 at
 * the hip and 1 at the knee (the cut), plus 100 x the leg's number. */
function legBender(L, P) {
    const d = L.model.drawables, legs = P.legs;
    const inLegs = inParts(L, [].concat.apply([], legs.map((g) => g.parts)));
    const cache = new Map();
    return (i) => {
        if (cache.has(i)) return cache.get(i);
        const v = d.vertexPositions[i], n = v.length / 2;
        let ymax = -Infinity; for (let k = 1; k < v.length; k += 2) ymax = Math.max(ymax, v[k]);
        if (!inLegs(i) && !(isFinite(P.below) && ymax < P.below)) { cache.set(i, null); return null; }
        const pos = new Float32Array(v.length), s = new Float32Array(n), knees = [];
        let first = -1;
        for (let k = 0; k < n; k++) {
            const x = v[2 * k], y = v[2 * k + 1];
            let j = 0, bd = Infinity;
            legs.forEach((g, q) => { const dd = Math.abs(x - g.hip[0] - (g.knee[0] - g.hip[0]) * 0.5); if (dd < bd) { bd = dd; j = q; } });
            if (first < 0) first = j;
            const g = legs[j];
            const [hx, hy] = g.hip, [kx, ky] = g.knee, Lt = hy - ky;
            const th = g.thigh[0] * Math.PI / 180, len = g.thigh[1];
            const ax = -Math.sin(th), ay = -Math.cos(th), px = Math.cos(th), py = -Math.sin(th);
            const nkx = hx + ax * Lt * len, nky = hy + ay * Lt * len;           // the knee, moved
            knees[j] = [nkx, nky];
            const sv = (hy - y) / Lt;
            const cx = hx + (kx - hx) * Math.min(1, Math.max(0, sv));     // the leg's centre line at this height
            const u = x - cx;
            const tx = hx + ax * Lt * len * sv + px * u, ty = hy + ay * Lt * len * sv + py * u;
            const sx = nkx + (x - kx), sy = nky - (sv - 1) * Lt;            // the shin hangs straight down from the new knee
            const bb = Math.min(1, Math.max(0, (sv - 0.9) / 0.2)), e = bb * bb * (3 - 2 * bb);
            pos[2 * k] = tx + (sx - tx) * e; pos[2 * k + 1] = ty + (sy - ty) * e;
            s[k] = sv + 100 * j;
        }
        const r = { pos, s, knees };
        cache.set(i, r);
        return r;
    };
}
/* The moved knees, per leg, in model units */
function kneesOf(P) {
    return P.legs.map((g) => {
        const Lt = g.hip[1] - g.knee[1], th = g.thigh[0] * Math.PI / 180;
        return [g.hip[0] - Math.sin(th) * Lt * g.thigh[1], g.hip[1] - Math.cos(th) * Lt * g.thigh[1]];
    });
}

async function bake(L, cfg) {
    for (const pose of ['stand', 'sit']) {
        const P = cfg[pose];
        if (!P) { log(pose + ': not in the config, skipped'); continue; }
        log(pose + ':');
        const ppu = cfg.pxPerUnit || 60, pad = cfg.pad || 2;
        const hidden = P.hide && P.hide.length ? inParts(L, P.hide) : () => false;
        const tailsIn = cfg.tails && cfg.tails.length ? inParts(L, cfg.tails) : null;
        const tails = tailsIn ? (i) => tailsIn(i) && !hidden(i) : null;
        const bend = pose === 'sit' && P.legs ? legBender(L, P) : null;
        const R = new Renderer(L);
        // every frame's geometry: the bent legs, thighs in the body (clip 1), shins in their own sprites (clip 2)
        const geomBody = bend ? (i) => { const b = bend(i); return b ? { pos: b.pos, s: b.s, clip: 1 } : null; } : null;
        const geomShin = (j) => (i) => { const b = bend(i); return b ? { pos: b.pos, s: b.s, clip: 2, leg: j } : { hide: true }; };
        // one box for every frame and sprite of the pose: the whole figure at idle, legs bent, tails swung room
        setParams(L, Object.assign({}, cfg.params, (cfg.frames && cfg.frames.idle && cfg.frames.idle.params) || {}));
        L.model.update();
        const allGeom = bend ? (i) => { const b = bend(i); return b ? { pos: b.pos, s: b.s } : null; } : null;
        let box = bounds(L, (i) => !hidden(i), allGeom);
        const m = 0.08; box = [box[0] - m, box[1] - 0.02, box[2] + m, box[3] + 0.02];
        const fw = Math.ceil((box[2] - box[0]) * ppu), fh = Math.ceil((box[3] - box[1]) * ppu);
        const toFrame = (x, y) => [(x - box[0]) * ppu, (box[3] - y) * ppu];
        log('  frame ' + fw + 'x' + fh + ' px');
        const render = (opts) => shrink(R.draw(fw * SS, fh * SS, box, opts), fw, fh);
        // body frames
        const names = ['idle', 'half', 'shut', 'happy', 'brake', 'talk'], frames = {};
        for (const n of names) {
            const f = (cfg.frames && cfg.frames[n]) || {};
            const ex = await expressionParams(f.expressions);
            setParams(L, Object.assign({}, cfg.params, ex, f.params || {}));
            L.model.update();
            frames[n] = render({ skip: (i) => hidden(i) || (tails ? tails(i) : false), geom: geomBody || undefined });
        }
        setParams(L, Object.assign({}, cfg.params, (cfg.frames && cfg.frames.idle && cfg.frames.idle.params) || {}));
        L.model.update();
        const sprites = [];
        let tl = null;
        if (tails) {
            const cv = render({ only: tails }), bb = alphaBox(cv);
            if (bb) tl = { cv, bb };
        }
        const shins = [];
        if (bend) P.legs.forEach((g, j) => {
            const cv = render({ geom: geomShin(j), skip: hidden }), bb = alphaBox(cv);
            const kn = kneesOf(P)[j], knee = toFrame(kn[0], kn[1]);
            if (bb) shins.push({ cv, bb, knee, limit: g.limit });
        });
        // pack: frames in rows, then the sprites, into a power-of-two-ish atlas no wider than 1024
        const items = names.map((n) => ({ n, cv: frames[n], bb: [0, 0, fw, fh] }));
        if (tl) items.push({ n: 'tails', cv: tl.cv, bb: tl.bb });
        shins.forEach((sh, j) => items.push({ n: 'shin' + j, cv: sh.cv, bb: sh.bb }));
        const W = 1024;
        let x = 0, y = 0, rowH = 0;
        items.forEach((it) => {
            const w = it.bb[2] + 2 * pad, h = it.bb[3] + 2 * pad;
            if (x + w > W) { x = 0; y += rowH; rowH = 0; }
            it.at = [x + pad, y + pad]; x += w; rowH = Math.max(rowH, h);
        });
        let AW = 64; while (AW < Math.max.apply(null, items.map((it) => it.at[0] + it.bb[2] + pad))) AW *= 2;
        const AH = y + rowH;
        const atlas = document.createElement('canvas'); atlas.width = AW; atlas.height = AH;
        const ag = atlas.getContext('2d');
        items.forEach((it) => ag.drawImage(it.cv, it.bb[0], it.bb[1], it.bb[2], it.bb[3], it.at[0], it.at[1], it.bb[2], it.bb[3]));
        const byN = {}; items.forEach((it) => { byN[it.n] = it; });
        const anchor = toFrame(P.anchor[0], P.anchor[1]);
        const ap = P.anchorPx || [0, 0];
        const info = {
            version: 1, pose, atlas: [AW, AH], frame: [fw, fh],
            frames: Object.fromEntries(names.map((n) => [n, byN[n].at])),
            anchor: [Math.round(anchor[0] - ap[0]), Math.round(anchor[1] - ap[1])],
            hipY: Math.round(toFrame(0, cfg.waist || 0.5)[1]), headY: Math.round(toFrame(0, box[3])[1]),
        };
        if (tl) {
            const t = byN.tails;
            info.tails = { rect: [t.at[0], t.at[1], t.bb[2], t.bb[3]], at: [t.bb[0], t.bb[1]], rootY: Math.round(t.bb[3] * (cfg.tailsRoot || 0.15)), length: Math.round(t.bb[3] * (1 - (cfg.tailsRoot || 0.15))) };
        }
        if (shins.length) info.shins = shins.map((sh, j) => {
            const t = byN['shin' + j];
            return { rect: [t.at[0], t.at[1], t.bb[2], t.bb[3]], at: [t.bb[0], t.bb[1]], pivot: [Math.round(sh.knee[0] - t.bb[0]), Math.round(sh.knee[1] - t.bb[1])], limit: isFinite(sh.limit) ? sh.limit : (j ? 0.15 : 0.03) };
        });
        // write: raw straight-alpha RGBA (what the HUD uploads), the description, a preview
        const px = ag.getImageData(0, 0, AW, AH).data;
        await fetch('/out/' + pose + '/atlas.rgba', { method: 'POST', body: new Blob([px]) });
        await fetch('/out/' + pose + '/atlas.json', { method: 'POST', body: JSON.stringify(info, null, 1) });
        await fetch('/out/' + pose + '/preview.png', { method: 'POST', body: await new Promise((r) => atlas.toBlob(r, 'image/png')) });
        log('  atlas ' + AW + 'x' + AH + ' (' + (AW * AH * 4 / 1048576).toFixed(2) + ' MiB, ' + (AW * AH * 8 / 1048576).toFixed(2) + ' MiB of the HUD pixel memory), ' + items.length + ' sprites');
        const show = document.createElement('img'); show.src = atlas.toDataURL(); view.appendChild(show);
    }
}

(async () => {
    try {
        const L = await loadModel();
        const cfg = await json('/config.json');
        log('model: ' + L.model.parameters.count + ' parameters, ' + L.model.parts.count + ' parts, ' + L.model.drawables.count + ' drawables, ' + L.imgs.length + ' textures');
        if (/[?&]inspect/.test(location.search)) await inspect(L, cfg);
        else await bake(L, cfg);
        log('done');
        document.title = 'Perch bake: done';
    } catch (e) {
        log('ERROR: ' + (e && e.stack || e));
        document.title = 'Perch bake: error';
    }
})();
