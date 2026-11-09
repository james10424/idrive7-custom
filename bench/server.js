'use strict';
/**
 * Bench: a stand-in for cluster-render on the Mac, for the apps that draw through it.
 *
 *   node bench/server.js [app_id ...]   then open http://localhost:8078
 *
 * app_id: custom_hud (the default, the 800x480 HUD) and / or custom_cluster (the 1920x720 cluster). Several apps run
 * together, as on the car: each its own process and connection to the one fake cluster-render, and the page draws each
 * app's target (its app.json config.target) with its own center-screen panel; the vehicle signals go to all of them.
 * The service's limits are modelled: 8 layers per connection (BENCH_LAYER_CAP=8; off by default), 32 across every
 * connection and 16 MiB of pixel memory with each image counted twice (both always on; see bench/README.md).
 *
 * - Listens on a Unix socket speaking cluster-render protocol v1 (the framing
 *   and ops the vendored client sends: u32 LE length, u8 type 'J'/'F'/'M').
 * - Builds the app with the kit (kit/tools/build.py, the build the Store runs on the car),
 *   then runs the built dist/ in the kit's stubbed head unit (bench/run-app.js), pointed at
 *   that socket. The center-screen settings go through the stub's RHMI components.
 * - Streams every layer, pixel push and uniform to a browser page that draws
 *   app's target. Effect layers run the app's real GLSL shader in
 *   WebGL. Layers stack by class, then z, as cluster-render orders them.
 * - Rebuilds and restarts the app when a file under its apps/<id>/, shared/ or kit/ changes. A layout
 *   saved into bench/.data/<id>/layouts/ (the data-folder override) is left to the app's own
 *   fs.watch, so that path gets tested too.
 * - Flags protocol mistakes (bad sizes, unknown refs, ops before hello) in
 *   the log instead of silently drawing something.
 *
 * Bench only, never shipped to the car. No dependencies beyond Node.
 * The app runs on Node 8.16.2 (the car's version) from .cache/node8 when it's
 * there; BENCH_NODE=/path/to/node overrides.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { fork, execFileSync } = require('child_process');
const { takeBuildLock, BUILD_LOCK_WAIT_MS } = require('./build_lock');
// What the driver sees of each target (hood curve, BMW's gear box and belt light, the HUD window):
// one source of truth, shared with the app's layout check. The page gets it in the 'hello' event.
const visible = require('../shared/visible');

const PORT = Number(process.env.BENCH_PORT) || 8078;
// BENCH_LAYER_CAP: the car seems to draw only an app's first 8 layers (photos, Nov 5 2026).
// 0 = unlimited. Layers past the cap get state 'waiting' and are not drawn. POST /cap sets it live.
let layerCap = Math.max(0, Number(process.env.BENCH_LAYER_CAP) || 0);
// The service's other two limits, always on (CompositorLimits): 32 layers across every connection, and 16 MiB of
// pixel memory for every image together, each image counted twice (Compositor::add_image), refused with the
// service's own words "the service's pixel memory is full". BENCH_PIXEL_MIB overrides the 16 (0 = unlimited).
const TOTAL_LAYERS = 32;
const PIXEL_BYTES = (process.env.BENCH_PIXEL_MIB === undefined ? 16 : Math.max(0, Number(process.env.BENCH_PIXEL_MIB) || 0)) * 1024 * 1024;
// the service's accounting: an image or asset costs its bytes twice (compositor.cpp: the pixels and a rectangle scratch)
function pixelBytes() { let n = 0; layers.forEach((l) => { if (l.image) n += l.iw * l.ih * (l.bpp || 4) * 2; }); return n; }
function layerCount() { let n = 0; layers.forEach((l) => { if (l.kind !== 'asset') n++; }); return n; }
const TOTAL_ASSETS = 32, ASSETS_PER_CLIENT = 16;   // CompositorLimits assets / assets_per_client
const mib = (b) => (b / 1048576).toFixed(1) + ' MiB';
const SOCK = path.join(os.tmpdir(), 'hud-bench-' + process.pid + '.sock');
const ROOT = path.join(__dirname, '..');
const APP_IDS = process.argv.slice(2).length ? process.argv.slice(2) : [process.env.BENCH_APP || 'custom_hud'];
// one entry per app: its folders (data/ on the bench: settings.json, layouts/), its process and what it last reported
const apps = APP_IDS.map((id) => {
    const dir = path.join(ROOT, 'apps', id);
    if (!fs.existsSync(path.join(dir, 'app.json'))) { console.error('no app ' + id + ' under apps/'); process.exit(2); }
    return { id, dir, data: path.join(__dirname, '.data', id), stage: path.join(ROOT, 'dist', id), child: null, stopping: false,
        restartTimer: null, lastSettings: null, lastStatus: null };
});
const appOf = (id) => apps.find((a) => a.id === id) || null;
const TARGETS = { hud: [800, 480], map: [1088, 480], panel: [1920, 720] };
const CLASSES = ['ambient', 'content', 'overlay', 'alert'];
const MAX_MSG = 5529664;
// The car runs Node 8.16.2, so run the app on that by default when it's in the drive cache.
const NODE8 = path.join(ROOT, '..', '..', '.cache', 'node8', 'node-v8.16.2-darwin-x64', 'bin', 'node');
const APP_NODE = process.env.BENCH_NODE || (fs.existsSync(NODE8) ? NODE8 : null);
/** The target the page draws for an app: its config.target (read again on each restart). */
function appView(a) {
    try { const t = JSON.parse(fs.readFileSync(path.join(a.dir, 'app.json'), 'utf8')).config.target; return TARGETS[t] ? t : 'hud'; } catch (e) { return 'hud'; }
}

/* ---------- browser side: Server-Sent Events out, small POSTs in ---------- */

const clients = new Set();
const logLines = [];
function send(obj, only) {
    const line = 'data: ' + JSON.stringify(obj) + '\n\n';
    (only ? [only] : Array.from(clients)).forEach((res) => res.write(line));
}
function log(level, text) {
    const entry = { t: 'log', level, text: new Date().toTimeString().slice(0, 8) + '  ' + text };
    logLines.push(entry);
    if (logLines.length > 400) logLines.shift();
    send(entry);
    (level === 'error' ? console.error : console.log)(entry.text);
}

/* ---------- the fake cluster-render ---------- */

const layers = new Map();   // key "conn:ref" -> layer
let nextConn = 1;

/** The visibility warnings for one layer's rect on its target (the same check layouts.js runs per widget). */
function layerWarnings(l) {
    return visible.check([{ id: '#' + l.ref, x: l.x, y: l.y, w: l.w, h: l.h }], l.target === 'panel' ? 'panel' : 'hud')
        .map((w) => w.replace(/^#\d+: /, ''));
}
function overCap() { return Array.from(layers.values()).filter((l) => l.state === 'waiting').length; }
function sceneMeta() {
    return Array.from(layers.values()).map((l) => ({
        key: l.key, conn: l.conn, ref: l.ref, app: l.app, kind: l.kind, target: l.target,
        class: l.class, z: l.z, x: l.x, y: l.y, w: l.w, h: l.h, visible: l.visible, opacity: l.opacity,
        exclusive: l.exclusive, iw: l.iw, ih: l.ih, fs: l.fs, time: l.time, uniforms: l.uniforms, binds: l.binds, format: l.format,
        state: l.state, reason: l.reason, warnings: l.kind === 'asset' ? [] : layerWarnings(l),
    }));
}
function helloMsg() {
    return { t: 'hello', targets: TARGETS, apps: apps.map((a) => ({ id: a.id, view: appView(a) })), view: appView(apps[0]),
        app: APP_IDS.join(' + '), cap: layerCap, pixelCap: PIXEL_BYTES,
        geometry: { HOOD: visible.HOOD, CAMERA: visible.CAMERA, BLACK_BOX: visible.BLACK_BOX, BELT: visible.BELT, GEAR: visible.GEAR, HUD_WINDOW: visible.HUD_WINDOW } };
}
let sceneTimer = null;
function sceneChanged() {
    if (sceneTimer) return;
    sceneTimer = setTimeout(() => { sceneTimer = null; send({ t: 'scene', layers: sceneMeta(), pixels: pixelBytes() }); }, 16);
}
/* Pixels never travel on the event stream: a 'px' notice names a rect of an image layer and the page fetches its
 * bytes from GET /px (binary, the layer's current pixels). Base64 on the stream choked the page once the engine
 * packed text into 1 MB sheets (Nov 5 2026). */
function sendPixels(l, only) {
    if (!l.image) return;
    sendRect(l, 0, 0, l.iw, l.ih, only);
}
function sendRect(l, x, y, w, h, only) {
    send({ t: 'px', key: l.key, iw: l.iw, ih: l.ih, x, y, w, h }, only);
}
/** GET /px?key=&x=&y=&w=&h=: that rect of the layer's image, raw RGBA rows. */
function pixelRect(q) {
    const l = layers.get(q.key);
    const x = Number(q.x), y = Number(q.y), w = Number(q.w), h = Number(q.h);
    if (!l || !l.image || !(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= l.iw && y + h <= l.ih)) return null;
    if (l.bpp === 1) {
        // an R8 asset: the page gets it as RGBA, the byte in R (what a shader's .r reads) and A, grey in G and B
        const out = Buffer.alloc(w * h * 4);
        for (let r = 0; r < h; r++) {
            for (let i = 0; i < w; i++) {
                const v = l.image[(y + r) * l.iw + x + i], o = (r * w + i) * 4;
                out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = v;
            }
        }
        return out;
    }
    if (x === 0 && w === l.iw) return l.image.slice(y * l.iw * 4, (y + h) * l.iw * 4);
    const out = Buffer.alloc(w * h * 4);
    for (let r = 0; r < h; r++) l.image.copy(out, r * w * 4, ((y + r) * l.iw + x) * 4, ((y + r) * l.iw + x + w) * 4);
    return out;
}

function writeEv(sock, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const m = Buffer.alloc(5 + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[4] = 0x4a;
    body.copy(m, 5);
    sock.write(m);
}

const renderServer = net.createServer((sock) => {
    const conn = nextConn++;
    const st = { conn, app: '?', hello: false, buf: Buffer.alloc(0) };
    const bad = (why) => { log('error', 'protocol [' + st.app + ']: ' + why); };
    const refuse = (op, ref, reason) => { bad(op + ' ref ' + ref + ': ' + reason); writeEv(sock, { ev: 'error', op, ref, reason }); };

    sock.on('data', (d) => {
        st.buf = st.buf.length ? Buffer.concat([st.buf, d]) : d;
        let off = 0;
        while (st.buf.length - off >= 5) {
            const len = st.buf.readUInt32LE(off);
            if (len < 1 || len > MAX_MSG) { bad('message length ' + len + ' out of range, closing'); sock.destroy(); return; }
            if (st.buf.length - off < 4 + len) break;
            const type = st.buf[off + 4];
            const body = st.buf.slice(off + 5, off + 4 + len);
            off += 4 + len;
            try { handle(type, body); } catch (e) { bad('handler threw: ' + e.stack); }
        }
        st.buf = st.buf.slice(off);
    });
    sock.on('error', () => {});
    sock.on('close', () => {
        let n = 0;
        layers.forEach((l, k) => { if (l.conn === conn) { layers.delete(k); n++; } });
        log('info', 'renderer: ' + st.app + ' disconnected, dropped its ' + n + ' layer(s)');
        sceneChanged();
    });

    function handle(type, body) {
        if (type === 0x4a) return onJson(body);
        if (!st.hello) return bad('binary message before hello');
        if (type === 0x46) return onFrame(body);
        if (type === 0x4d) return bad('mesh geometry received; the bench does not draw meshes');
        bad('unknown message type 0x' + type.toString(16));
    }

    function onJson(body) {
        let m;
        try { m = JSON.parse(body.toString('utf8')); } catch (e) { return bad('JSON message does not parse: ' + e.message); }
        if (m.op === 'hello') {
            st.hello = true;
            st.app = m.app || '?';
            if (m.proto !== 1) bad('hello proto ' + m.proto + ', service speaks 1');
            log('info', 'renderer: hello from ' + st.app + ' (proto ' + m.proto + ')');
            writeEv(sock, { ev: 'hello', backend: 'bench', targets: Object.keys(TARGETS).join(',') });
            return;
        }
        if (!st.hello) return bad(m.op + ' before hello');
        const key = conn + ':' + m.ref;
        const l = layers.get(key);
        switch (m.op) {
            case 'layer': {
                if (!TARGETS[m.target]) return refuse('layer', m.ref, 'unknown target ' + m.target);
                if (m.class && CLASSES.indexOf(m.class) < 0) return refuse('layer', m.ref, 'unknown class ' + m.class);
                if (m.z !== undefined && (m.z < -1000 || m.z > 1000)) return refuse('layer', m.ref, 'z out of -1000..1000');
                const [tw, th] = TARGETS[m.target];
                if (layerCount() >= TOTAL_LAYERS) return refuse('layer', m.ref, 'too many layers');
                if (m.kind === 'image' && PIXEL_BYTES && m.iw > 0 && m.ih > 0 && pixelBytes() + m.iw * m.ih * 8 > PIXEL_BYTES) {
                    return refuse('layer', m.ref, "the service's pixel memory is full");
                }
                const nl = {
                    key, conn, ref: m.ref, app: st.app, kind: m.kind, target: m.target,
                    class: m.class || 'content', z: m.z || 0, x: m.x || 0, y: m.y || 0, w: m.w || 0, h: m.h || 0,
                    visible: m.visible === undefined ? 1 : m.visible, opacity: m.opacity === undefined ? 1 : m.opacity,
                    exclusive: m.exclusive || 0, uniforms: {}, state: 'shown', reason: '',
                };
                // The layer cap: count this connection's live layers that got a slot; past the cap, the
                // layer is registered (so set/uniform/frames on it stay valid) but waits and is not drawn.
                if (layerCap > 0) {
                    let shown = 0, live = 0;
                    layers.forEach((o) => { if (o.conn === conn && o.kind !== 'asset') { live++; if (o.state === 'shown') shown++; } });
                    if (shown >= layerCap) {
                        nl.state = 'waiting'; nl.reason = 'bench: over the layer cap of ' + layerCap;
                        log('warn', 'layer ' + m.ref + ' (' + m.kind + ' ' + nl.x + ',' + nl.y + ' ' + nl.w + 'x' + nl.h + ') is live layer #' + (live + 1) + ' on this connection: over the layer cap of ' + layerCap + ', not drawn');
                    }
                }
                if (nl.x + nl.w > tw || nl.y + nl.h > th || nl.x < 0 || nl.y < 0) {
                    log('warn', 'layer ' + m.ref + ' (' + nl.x + ',' + nl.y + ' ' + nl.w + 'x' + nl.h + ') runs off the ' + tw + 'x' + th + ' ' + m.target + ' target');
                }
                if (nl.exclusive) log('warn', 'layer ' + m.ref + ' is exclusive: it hides everything under it (CarPlay/AA map too)');
                if (m.kind === 'image') {
                    nl.iw = m.iw; nl.ih = m.ih; nl.bpp = 4;
                    if (!(m.iw > 0 && m.ih > 0 && m.iw <= 1920 && m.ih <= 720)) return refuse('layer', m.ref, 'image iw/ih out of range');
                    nl.image = Buffer.alloc(m.iw * m.ih * 4);
                } else if (m.kind === 'effect') {
                    if (!m.fs) return refuse('layer', m.ref, 'effect without fs');
                    nl.fs = m.fs; nl.time = !!m.time; nl.binds = {};
                } else {
                    log('warn', 'layer ' + m.ref + ': kind ' + m.kind + ' is not drawn by the bench');
                }
                layers.set(key, nl);   // its visibility warnings (hood, gear box, belt light, HUD window) ride along in sceneMeta()
                if (nl.state === 'waiting') writeEv(sock, { ev: 'layer', ref: m.ref, state: 'waiting', reason: nl.reason });
                else writeEv(sock, { ev: 'layer', ref: m.ref, state: 'shown' });
                sceneChanged();
                return;
            }
            case 'asset': {
                // PROTOCOL.md "asset": an R8 or RGBA8 texture, not drawn, not a layer; effect layers sample it through "bind".
                // The service's limits: 32 assets, 16 per client, 1..2048 a side, within one frame message; pixel memory twice its bytes.
                if (!TARGETS[m.target]) return refuse('asset', m.ref, 'unknown target ' + m.target);
                const format = m.format || 'rgba8', bpp = format === 'r8' ? 1 : format === 'rgba8' ? 4 : 0;
                if (!bpp) return refuse('asset', m.ref, 'unknown asset format ' + format);
                if (!(m.w > 0 && m.h > 0 && m.w <= 2048 && m.h <= 2048 && m.w * m.h * bpp + 64 <= 1920 * 720 * 4 + 64)) return refuse('asset', m.ref, 'asset size out of range');
                let all = 0, mine = 0;
                layers.forEach((o) => { if (o.kind === 'asset') { all++; if (o.conn === conn) mine++; } });
                if (all >= TOTAL_ASSETS || mine >= ASSETS_PER_CLIENT) return refuse('asset', m.ref, 'too many assets');
                if (PIXEL_BYTES && pixelBytes() + m.w * m.h * bpp * 2 > PIXEL_BYTES) return refuse('asset', m.ref, "the service's pixel memory is full");
                layers.set(key, {
                    key, conn, ref: m.ref, app: st.app, kind: 'asset', target: m.target, format, bpp, class: '-', z: 0,
                    x: 0, y: 0, w: m.w, h: m.h, iw: m.w, ih: m.h, visible: 0, opacity: 1, exclusive: 0, uniforms: {},
                    image: Buffer.alloc(m.w * m.h * bpp), state: 'shown', reason: '',
                });
                log('info', 'asset ' + m.ref + ': ' + format + ' ' + m.w + 'x' + m.h + ' (' + mib(m.w * m.h * bpp * 2) + ' of pixel memory)');
                writeEv(sock, { ev: 'layer', ref: m.ref, state: 'shown' });
                sceneChanged();
                return;
            }
            case 'bind': {
                if (!l) return refuse('bind', m.ref, 'no such layer');
                if (l.kind !== 'effect') return refuse('bind', m.ref, 'bind on a ' + l.kind + ' layer');
                const a = layers.get(conn + ':' + m.asset);
                if (!a || a.kind !== 'asset') return refuse('bind', m.ref, 'no such asset ' + m.asset);
                if (a.target !== l.target) return refuse('bind', m.ref, 'the asset is on another target');
                l.binds[m.sampler] = a.key;
                sceneChanged();
                return;
            }
            case 'set': {
                if (!l) return refuse('set', m.ref, 'no such layer');
                ['class', 'z', 'x', 'y', 'w', 'h', 'visible', 'exclusive', 'opacity'].forEach((k) => { if (m[k] !== undefined) l[k] = m[k]; });
                sceneChanged();
                return;
            }
            case 'drop': {
                if (!l) return refuse('drop', m.ref, 'no such layer');
                if (l.kind === 'asset') {
                    let used = false;
                    layers.forEach((o) => { if (o.binds && Object.keys(o.binds).some((s) => o.binds[s] === key)) used = true; });
                    if (used) return refuse('drop', m.ref, 'asset in use');
                }
                layers.delete(key);
                sceneChanged();
                return;
            }
            case 'uniform': {
                if (!l) return refuse('uniform', m.ref, 'no such layer');
                if (l.kind !== 'effect') return refuse('uniform', m.ref, 'uniform on a ' + l.kind + ' layer');
                const v = String(m.v).trim().split(/\s+/).map(Number);
                if (v.some((n) => !isFinite(n))) return refuse('uniform', m.ref, 'non-numeric value "' + m.v + '"');
                // PROTOCOL.md "Uniforms": without type, 1-4 numbers; with type, whole elements, up to 1024
                // numbers (an array uniform). Both the numbers and the type reach the page.
                const WIDTH = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat4: 16 };
                if (m.type !== undefined) {
                    if (!WIDTH[m.type]) return refuse('uniform', m.ref, 'unknown uniform type "' + m.type + '"');
                    if (v.length > 1024 || v.length % WIDTH[m.type]) return refuse('uniform', m.ref, 'uniform ' + m.name + ': ' + v.length + ' numbers is not whole ' + m.type + 's (or over 1024)');
                } else if (v.length > 4) return refuse('uniform', m.ref, 'uniform ' + m.name + ': ' + v.length + ' numbers without a type (max 4)');
                // the car's cluster-render keeps at most 32 uniform names a layer (Uniforms::kMaxNames, 0.4.5), u_time among
                // them on a layer with the renderer's clock, and refuses a new one past that (Custom HUD 0.1.9's Miku sent 34
                // and the car refused it, Nov 8 2026; the bench had let it through)
                const maxU = 32 - (l.time ? 1 : 0);
                if (!l.uniforms[m.name] && Object.keys(l.uniforms).length >= maxU) return refuse('uniform', m.ref, 'at most 32 uniforms a layer');
                l.uniforms[m.name] = { v, type: m.type || null };
                sceneChanged();
                return;
            }
            case 'status':
                const conns = new Set(Array.from(layers.values()).map((l) => l.conn)).size;
                const assets = layers.size - layerCount();
                writeEv(sock, { ev: 'status', text: 'bench: ' + layerCount() + ' layers' + (assets ? ' and ' + assets + ' asset' + (assets > 1 ? 's' : '') : '') + ' on ' + conns + ' connection(s), layer cap ' + (layerCap || 'off') + ', ' + overCap() + ' over it, pixel memory ' + mib(pixelBytes()) + ' of ' + (PIXEL_BYTES ? mib(PIXEL_BYTES) : 'unlimited') });
                return;
            default:
                bad('op "' + m.op + '" not handled by the bench');
        }
    }

    function onFrame(body) {
        if (body.length < 14) return bad('frame message too short');
        const ref = body.readUInt32LE(0);
        const n = body.readUInt16LE(12);
        const l = layers.get(conn + ':' + ref);
        if (!l) return bad('frame for unknown ref ' + ref);
        if (l.kind !== 'image' && l.kind !== 'asset') return bad('frame for a ' + l.kind + ' layer (ref ' + ref + ')');
        const head = 14 + n * 8, bpp = l.bpp || 4;
        const px = body.slice(head);
        if (n === 0) {
            if (px.length !== l.image.length) return bad('whole frame for ref ' + ref + ' is ' + px.length + ' bytes, layer needs ' + l.image.length);
            px.copy(l.image);
        } else {
            let o = 0;
            const rects = [];
            for (let i = 0; i < n; i++) {
                const x = body.readUInt16LE(14 + i * 8), y = body.readUInt16LE(16 + i * 8);
                const w = body.readUInt16LE(18 + i * 8), h = body.readUInt16LE(20 + i * 8);
                if (x + w > l.iw || y + h > l.ih) return bad('dirty rect off the image on ref ' + ref);
                for (let r = 0; r < h; r++) { px.copy(l.image, ((y + r) * l.iw + x) * bpp, o, o + w * bpp); o += w * bpp; }
                rects.push([x, y, w, h]);
            }
            if (o !== px.length) return bad('dirty rects for ref ' + ref + ' carry ' + px.length + ' bytes, expected ' + o);
            if (l.sentWhole) { rects.forEach((r) => sendRect(l, r[0], r[1], r[2], r[3])); return; }
        }
        l.sentWhole = true;
        sendPixels(l);
    }
});

/* ---------- the app children ---------- */

let signals = { t: 'signals', mode: 'demo', values: {} };
let drive = { t: 'drive', value: null };   // the drive mode buttons (FES actualValueModeDrivingExperience), null = car hasn't said
let nav = { t: 'nav', value: null };       // route guidance (Guidance guidanceState: 'ACTIVE', 'INACTIVE'), null = car hasn't said
let carSw = {};                             // the car switches (page "Car switches": turn signals, brake lights, parking brake, ...), key -> value
let assist = { t: 'assist', value: null }; // BMW's HUD driver assistance block (DisplayDataServer): 'acc' or 'off', null = car hasn't said
/** A message to every running app (the vehicle signals are the car's, so every app gets them). */
function toApps(m) { apps.forEach((a) => { if (a.child) a.child.send(m); }); }

function build(a) {
    // The kit's build needs an oap-sdk folder; on the Mac that is a stub (see bench/README.md).
    const sdk = path.join(ROOT, 'oap-sdk');
    if (!fs.existsSync(path.join(sdk, 'index.js'))) {
        fs.mkdirSync(sdk, { recursive: true });
        fs.writeFileSync(path.join(sdk, 'index.js'), "'use strict';\n// BENCH_STUB: stands in for BMW's oap-sdk so kit/tools/build.py runs on the Mac. Never ship this.\nthrow new Error('BENCH_STUB oap-sdk');\n");
        fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'oap-sdk', version: '0.0.0-bench-stub', main: 'index.js' }) + '\n');
    }
    // Every bench running on this repo builds into the same dist/<id>/ (two benches, e.g. "bench" and "bench-hud",
    // both rebuild an app when one of its files is saved), so a build holds a lock other benches wait for.
    const lock = takeBuildLock(path.join(ROOT, 'dist'), a.id, (level, text) => log(level, text));
    if (!lock) { log('error', 'build ' + a.id + ': another bench has been building it for over ' + BUILD_LOCK_WAIT_MS / 1000 + ' s; restart to try again'); return false; }
    try {
        const out = execFileSync('python3', [path.join(ROOT, 'kit', 'tools', 'build.py'), a.id], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        String(out).split('\n').filter(Boolean).forEach((ln) => log('info', 'build ' + a.id + ': ' + ln.trim()));
        return true;
    } catch (e) {
        log('error', 'build ' + a.id + ' failed: ' + String(e.stderr || e.message).trim());
        return false;
    } finally {
        lock();
    }
}

function startApp(a) {
    try { fs.mkdirSync(a.data, { recursive: true }); } catch (e) { /* there */ }
    send(helloMsg());
    if (!build(a)) { send({ t: 'app', app: a.id, state: 'stopped' }); return; }
    const opts = { cwd: a.data, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, { HUD_CLUSTER_SOCKET: SOCK }) };
    if (APP_NODE) opts.execPath = APP_NODE;
    const c = a.child = fork(path.join(__dirname, 'run-app.js'), [a.stage, a.data], opts);
    if (drive.value !== null) c.send(drive);
    if (nav.value !== null) c.send(nav);
    if (assist.value !== null) c.send(assist);
    Object.keys(carSw).forEach((k) => c.send({ t: 'car', key: k, value: carSw[k] }));
    const pipe = (stream, level) => {
        let rest = '';
        stream.on('data', (d) => {
            const lines = (rest + d).split('\n');
            rest = lines.pop();
            lines.forEach((ln) => ln && log(/WARN|Error|error/.test(ln) ? 'warn' : level, 'app: ' + ln));
        });
    };
    pipe(c.stdout, 'info');
    pipe(c.stderr, 'warn');
    c.on('message', (m) => {
        if (!m) return;
        m.app = a.id;
        if (m.t === 'settings') a.lastSettings = m;
        if (m.t === 'status') { a.lastStatus = m; log('info', 'center screen status [' + a.id + ']: ' + m.s + (m.d ? ' / ' + m.d : '')); }
        if (m.t === 'values' || m.t === 'settings' || m.t === 'status') send(m);
    });
    c.on('exit', (code, sig) => {
        if (c !== a.child) return;
        a.child = null;
        send({ t: 'app', app: a.id, state: 'stopped' });
        if (!a.stopping) log('error', a.id + ' exited (code ' + code + (sig ? ', ' + sig : '') + '); fix and save to restart');
    });
    c.send(signals);
    send({ t: 'app', app: a.id, state: 'running' });
    log('info', a.id + ' started on ' + (APP_NODE ? APP_NODE.replace(/^.*\/(node-v[^/]+)\/.*$/, '$1') : 'node ' + process.version + ' (not the car\'s Node 8)'));
}

function restartApp(a, why) {
    // already stopping the old one, with a start queued on its exit: a second start now would run the app twice
    if (a.stopping) { log('info', 'restarting ' + a.id + ': ' + why + ' (already restarting)'); return; }
    log('info', 'restarting ' + a.id + ': ' + why);
    if (a.child) {
        const old = a.child;
        a.child = null;
        a.stopping = true;
        old.once('exit', () => { a.stopping = false; startApp(a); });
        old.kill('SIGTERM');
        setTimeout(() => { try { old.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1500);
    } else startApp(a);
}
const restartAll = (why) => apps.forEach((a) => restartApp(a, why));

// an app's own folder restarts that app; shared/ and kit/ restart them all
const watchFor = (dir, targets) => fs.watch(dir, { recursive: true }, (ev, file) => {
    if (!file || /(^|\/)\./.test(file) || /__pycache__/.test(file)) return;
    targets.forEach((a) => {
        clearTimeout(a.restartTimer);
        a.restartTimer = setTimeout(() => restartApp(a, path.basename(dir) + '/' + file + ' changed'), 300);
    });
});
apps.forEach((a) => watchFor(a.dir, [a]));
[path.join(ROOT, 'shared'), path.join(ROOT, 'kit')].forEach((dir) => watchFor(dir, apps));

/* ---------- HTTP ---------- */

function body(req) {
    return new Promise((resolve) => {
        let s = '';
        req.on('data', (d) => { s += d; if (s.length > 1e5) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
    });
}

const web = http.createServer(async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    if (host !== 'localhost' && host !== '127.0.0.1') { res.writeHead(403); return res.end(); }
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(__dirname, 'page.html')).pipe(res);
    }
    if (req.method === 'GET' && url === '/px') {
        const q = {};
        (req.url.split('?')[1] || '').split('&').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); });
        const px = pixelRect(q);
        if (!px) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(px);
    }
    if (req.method === 'GET' && url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        clients.add(res);
        req.on('close', () => clients.delete(res));
        send(helloMsg(), res);
        logLines.forEach((e) => send(e, res));
        send({ t: 'scene', layers: sceneMeta(), pixels: pixelBytes() }, res);
        layers.forEach((l) => sendPixels(l, res));
        apps.forEach((a) => { if (a.lastSettings) send(a.lastSettings, res); if (a.lastStatus) send(a.lastStatus, res); });
        send(nav, res); send(assist, res);      // the page draws BMW's guidance and ACC stand-ins from these
        send({ t: 'car', values: carSw }, res);
        apps.forEach((a) => send({ t: 'app', app: a.id, state: a.child ? 'running' : 'stopped' }, res));
        return;
    }
    if (req.method === 'POST' && url === '/signals') {
        const b = await body(req);
        signals = { t: 'signals', mode: b.mode === 'manual' ? 'manual' : 'demo', values: b.values || {} };
        toApps(signals);
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/drive') {
        const b = await body(req);
        drive = { t: 'drive', value: b.value === null || b.value === undefined ? null : b.value };
        toApps(drive);
        log('info', 'bench: drive mode ' + JSON.stringify(drive.value));
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/nav') {
        const b = await body(req);
        nav = { t: 'nav', value: typeof b.value === 'string' ? b.value : null };
        toApps(nav);
        send(nav);
        log('info', 'bench: route guidance ' + JSON.stringify(nav.value));
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/car') {
        const b = await body(req);
        if (typeof b.key === 'string' && /^[a-zA-Z]+$/.test(b.key)) {
            if (typeof b.value === 'string' && b.value) carSw[b.key] = b.value; else delete carSw[b.key];
            toApps({ t: 'car', key: b.key, value: carSw[b.key] || null });
            send({ t: 'car', values: carSw });
            log('info', 'bench: ' + b.key + ' ' + JSON.stringify(carSw[b.key] || null));
        }
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/assist') {
        const b = await body(req);
        assist = { t: 'assist', value: b.value === 'acc' || b.value === 'off' ? b.value : null };
        toApps(assist);
        send(assist);
        log('info', 'bench: driver assistance ' + JSON.stringify(assist.value));
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/restart') {
        const b = await body(req), a = appOf(b.app);
        if (a) restartApp(a, 'restart button'); else restartAll('restart button');
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/shot') {
        // a README screenshot: the page posts a canvas as a PNG data URL; written to docs/images/<name>.png (name: letters,
        // digits, - and _ only)
        let s = '';
        req.on('data', (d) => { s += d; if (s.length > 2e7) req.destroy(); });
        req.on('end', () => {
            try {
                const b = JSON.parse(s), name = String(b.name || '');
                const m = /^data:image\/png;base64,(.+)$/.exec(String(b.data || ''));
                if (!/^[a-z0-9_-]{1,40}$/i.test(name) || !m) { res.writeHead(400); return res.end('bad name or data'); }
                const out = path.join(ROOT, 'docs', 'images', name + '.png');
                fs.writeFileSync(out, Buffer.from(m[1], 'base64'));
                log('info', 'screenshot written: ' + path.relative(ROOT, out));
                res.writeHead(204); res.end();
            } catch (e) { res.writeHead(400); res.end(String(e.message || e)); }
        });
        return;
    }
    if (req.method === 'POST' && url === '/cap') {
        // The layer cap, set live from the page. The app restarts so it registers its layers again under the new cap.
        const b = await body(req);
        const n = Math.max(0, Math.floor(Number(b.cap) || 0));
        if (n !== layerCap) {
            layerCap = n;
            send(helloMsg());
            restartAll('layer cap set to ' + (n || 'unlimited') + ', the apps register their layers again');
        }
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/setting') {
        // Pressed on the stub's RHMI components, as the car's settings page sends it (run-app.js).
        const b = await body(req), a = appOf(b.app) || apps[0];
        if (!a.child) { res.writeHead(409); return res.end('app not running'); }
        a.child.send({ t: 'set', key: b.key, value: b.value });
        log('info', 'bench: ' + a.id + ' setting ' + b.key + ' = ' + JSON.stringify(b.value));
        res.writeHead(204); return res.end();
    }
    res.writeHead(404); res.end();
});

try { fs.unlinkSync(SOCK); } catch (e) { /* not there */ }
renderServer.listen(SOCK, () => {
    web.listen(PORT, '127.0.0.1', () => {
        log('info', 'bench renderer on ' + SOCK);
        log('info', 'open http://localhost:' + PORT);
        if (layerCap) log('info', 'layer cap ' + layerCap + ' (BENCH_LAYER_CAP): layers past it get state waiting and are not drawn');
        log('info', 'the service\'s limits: ' + TOTAL_LAYERS + ' layers across every connection, pixel memory ' + (PIXEL_BYTES ? mib(PIXEL_BYTES) : 'unlimited') + ' (every image counted twice)');
        apps.forEach(startApp);
    });
});
function shutdown() {
    apps.forEach((a) => { a.stopping = true; if (a.child) a.child.kill('SIGTERM'); });
    try { fs.unlinkSync(SOCK); } catch (e) { /* gone */ }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
