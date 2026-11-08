'use strict';
/* Perch bake page (served by serve.js): the standing frames. A small WebGL renderer on Live2D's Cubism Core: drawables in render order,
 * clipping masks through the stencil buffer, normal / additive / multiplicative blending, multiply and screen colours.
 * No physics: the model is posed by parameters only, and the HUD's shader adds the motion.
 *
 * CONFIG (the --config file, kept next to the model):
 *   params      { id: value } set on every frame (e.g. a watermark off, a toggle on)
 *   frames      { idle | half | shut | talk: { params: { id: value }, expressions: ["X.exp3.json"] } }: each frame's
 *               own parameters, on top of "params": the blink (eyes open, half, shut) and a smile with the mouth open
 *   lean        { steps: 11, params: { id: value at a full lean right }, left: { id: value }, right: { id: value },
 *               face: 0.6 }: her, standing on a bus, leaning with the model's body and head rotation, baked at "steps"
 *               angles from a full lean left (the car braking) to a full lean right (pulling away); each angle's params
 *               are "params" times -1 .. 1. From "face" on, the left ones add "left" (the braking face) and the right
 *               ones "right" (the happy face). Neighbouring angles are close enough to blend without a double image
 *   tails       ["part id", ...]: drawn in their own sprite (swung by the HUD), hidden in the body frames
 *   tailsRoot   0..1: where the tails hang from, as a fraction down the tails sprite (0.15)
 *   anchor      [x, y] the model point between her feet (model units, y up, as ?inspect's grid shows them): it goes on
 *               the Perch widget's "feet" point; anchorPx [x, y] px added to it on the HUD (right, down)
 *   hide        ["part id"]: left out entirely
 *   pxPerUnit   HUD px per model unit (her size on the HUD)
 *   waist       model y the upper body breathes and leans above
 *   headY       model y across her face (1.3): where the bake measures how far each lean moves her head
 *   pad         px of transparent border round each sprite (2)
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
const VS = `attribute vec2 a_pos; attribute vec2 a_uv;
uniform vec4 u_xf; varying vec2 v_uv;
void main() { gl_Position = vec4(a_pos * u_xf.xy + u_xf.zw, 0.0, 1.0); v_uv = vec2(a_uv.x, 1.0 - a_uv.y); }`;
const FS = `precision mediump float;
uniform sampler2D u_tex; uniform float u_op; uniform vec4 u_mul; uniform vec4 u_scr; uniform float u_mask;
varying vec2 v_uv;
void main() {
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
        this.loc = { pos: gl.getAttribLocation(p, 'a_pos'), uv: gl.getAttribLocation(p, 'a_uv') };
        this.u = {}; ['u_xf', 'u_tex', 'u_op', 'u_mul', 'u_scr', 'u_mask'].forEach((n) => { this.u[n] = gl.getUniformLocation(p, n); });
        this.bufPos = gl.createBuffer(); this.bufUv = gl.createBuffer(); this.bufIdx = gl.createBuffer();
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
     * opts.skip(i): which drawables. */
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
            const masks = d.masks[i], n = d.maskCounts[i];
            if (n > 0) {
                gl.enable(gl.STENCIL_TEST);
                gl.clear(gl.STENCIL_BUFFER_BIT);
                gl.colorMask(false, false, false, false);
                gl.stencilFunc(gl.ALWAYS, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
                gl.uniform1f(this.u.u_mask, 1);
                for (let k = 0; k < n; k++) this._mesh(masks[k]);
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
            this._mesh(i);
            if (n > 0) gl.disable(gl.STENCIL_TEST);
        });
        return this.canvas;
    }

    _mesh(i) {
        const gl = this.gl, d = this.L.model.drawables;
        const pos = d.vertexPositions[i];
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex[d.textureIndices[i]]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufUv); gl.bufferData(gl.ARRAY_BUFFER, d.vertexUvs[i], gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.loc.uv); gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 0, 0);
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
function bounds(L, only) {
    const d = L.model.drawables;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < d.count; i++) {
        if (!C.Utils.hasIsVisibleBit(d.dynamicFlags[i]) || d.opacities[i] <= 0.001 || (only && !only(i))) continue;
        const v = d.vertexPositions[i];
        for (let k = 0; k < v.length; k += 2) {
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
    // a grid every 0.1 model units, labelled, to read positions off (the anchor between her feet, the waist, the face)
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

async function bake(L, cfg) {
    const ppu = cfg.pxPerUnit || 60, pad = cfg.pad || 2;
    const hidden = cfg.hide && cfg.hide.length ? inParts(L, cfg.hide) : () => false;
    const tailsIn = cfg.tails && cfg.tails.length ? inParts(L, cfg.tails) : null;
    const tails = tailsIn ? (i) => tailsIn(i) && !hidden(i) : null;
    const R = new Renderer(L);
    const idle = (cfg.frames && cfg.frames.idle && cfg.frames.idle.params) || {};
    // one box for every frame and sprite: the whole figure at idle, with a margin for the swaying tails
    setParams(L, Object.assign({}, cfg.params, idle));
    L.model.update();
    let box = bounds(L, (i) => !hidden(i));
    const m = 0.08; box = [box[0] - m, box[1] - 0.02, box[2] + m, box[3] + 0.02];
    const fw = Math.ceil((box[2] - box[0]) * ppu), fh = Math.ceil((box[3] - box[1]) * ppu);
    const toFrame = (x, y) => [(x - box[0]) * ppu, (box[3] - y) * ppu];
    log('frame ' + fw + 'x' + fh + ' px');
    const render = (opts) => shrink(R.draw(fw * SS, fh * SS, box, opts), fw, fh);
    const body = { skip: (i) => hidden(i) || (tails ? tails(i) : false) };
    const names = ['idle', 'half', 'shut', 'talk'], frames = {};
    for (const n of names) {
        const f = (cfg.frames && cfg.frames[n]) || {};
        const ex = await expressionParams(f.expressions);
        setParams(L, Object.assign({}, cfg.params, ex, f.params || {}));
        L.model.update();
        frames[n] = render(body);
    }
    // the lean angles, left to right; the middle one is upright (idle itself, not baked again)
    const LN = (cfg.lean && cfg.lean.steps) || 11, lp = (cfg.lean && cfg.lean.params) || {}, faceAt = (cfg.lean && cfg.lean.face) || 0.6;
    const leanNames = [];
    for (let k = 0; k < LN; k++) {
        const a = -1 + 2 * k / (LN - 1);
        if (Math.abs(a) < 1e-6) { leanNames.push('idle'); continue; }
        const q = {};
        Object.keys(lp).forEach((id) => { q[id] = lp[id] * a; });
        if (a <= -faceAt + 1e-6) Object.assign(q, (cfg.lean && cfg.lean.left) || {});
        if (a >= faceAt - 1e-6) Object.assign(q, (cfg.lean && cfg.lean.right) || {});
        setParams(L, Object.assign({}, cfg.params, idle, q));
        L.model.update();
        const n = 'lean' + k;
        frames[n] = render(body);
        names.push(n); leanNames.push(n);
    }
    setParams(L, Object.assign({}, cfg.params, idle));
    L.model.update();
    let tl = null;
    if (tails) {
        const cv = render({ only: tails }), bb = alphaBox(cv);
        if (bb) tl = { cv, bb };
    }
    // pack the frames in rows no wider than 1024, then the tails
    const items = names.map((n) => ({ n, cv: frames[n], bb: [0, 0, fw, fh] }));
    if (tl) items.push({ n: 'tails', cv: tl.cv, bb: tl.bb });
    let x = 0, y = 0, rowH = 0;
    items.forEach((it) => {
        const w = it.bb[2] + 2 * pad, h = it.bb[3] + 2 * pad;
        if (x + w > 1024) { x = 0; y += rowH; rowH = 0; }
        it.at = [x + pad, y + pad]; x += w; rowH = Math.max(rowH, h);
    });
    let AW = 64; while (AW < Math.max.apply(null, items.map((it) => it.at[0] + it.bb[2] + pad))) AW *= 2;
    const AH = y + rowH;
    const atlas = document.createElement('canvas'); atlas.width = AW; atlas.height = AH;
    const ag = atlas.getContext('2d');
    items.forEach((it) => ag.drawImage(it.cv, it.bb[0], it.bb[1], it.bb[2], it.bb[3], it.at[0], it.at[1], it.bb[2], it.bb[3]));
    const byN = {}; items.forEach((it) => { byN[it.n] = it; });
    // where her head is in each lean frame (the alpha centroid of a band across the head), so the HUD can slide the
    // two nearest lean angles onto each other while it blends them instead of fading one through the other
    const headMid = Math.round(toFrame(0, cfg.headY || 1.3)[1]);
    const bandY0 = Math.max(0, headMid - Math.round(fh * 0.04)), bandY1 = Math.min(fh, headMid + Math.round(fh * 0.04));
    const headX = (cv) => {
        const dd = cv.getContext('2d').getImageData(0, bandY0, fw, bandY1 - bandY0).data;
        let sx = 0, sa = 0;
        for (let k = 0; k < dd.length; k += 4) { const a = dd[k + 3]; sx += ((k / 4) % fw) * a; sa += a; }
        return sa ? sx / sa : fw / 2;
    };
    const x0 = headX(frames.idle);
    const shift = leanNames.map((n) => Math.round((headX(frames[n]) - x0) * 10) / 10);
    log('head shift per lean angle (px): ' + shift.join(', '));
    const an = cfg.anchor || [0, box[1]], ap = cfg.anchorPx || [0, 0], anchor = toFrame(an[0], an[1]);
    const info = {
        version: 1, atlas: [AW, AH], frame: [fw, fh],
        frames: Object.fromEntries(names.map((n) => [n, byN[n].at])),
        lean: leanNames.map((n) => byN[n].at),
        anchor: [Math.round(anchor[0] - ap[0]), Math.round(anchor[1] - ap[1])],
        hipY: Math.round(toFrame(0, cfg.waist || 0.5)[1]), headY: Math.round((bandY0 + bandY1) / 2), leanShift: shift,
    };
    if (tl) {
        const t = byN.tails, root = cfg.tailsRoot || 0.15;
        info.tails = { rect: [t.at[0], t.at[1], t.bb[2], t.bb[3]], at: [t.bb[0], t.bb[1]], rootY: Math.round(t.bb[3] * root), length: Math.round(t.bb[3] * (1 - root)) };
    }
    // write: raw straight-alpha RGBA (what the HUD uploads), the description, a preview
    const px = ag.getImageData(0, 0, AW, AH).data;
    await fetch('/out/atlas.rgba', { method: 'POST', body: new Blob([px]) });
    await fetch('/out/atlas.json', { method: 'POST', body: JSON.stringify(info, null, 1) });
    await fetch('/out/preview.png', { method: 'POST', body: await new Promise((r) => atlas.toBlob(r, 'image/png')) });
    log('atlas ' + AW + 'x' + AH + ' (' + (AW * AH * 4 / 1048576).toFixed(2) + ' MiB, ' + (AW * AH * 8 / 1048576).toFixed(2) + ' MiB of the HUD pixel memory), ' + items.length + ' sprites');
    const show = document.createElement('img'); show.src = atlas.toDataURL(); view.appendChild(show);
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
