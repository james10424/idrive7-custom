"use strict";
/**
 * Bench: a stand-in for cluster-render on the Mac, for the apps that draw through it.
 *
 *   node bench/server.js [app_id ...]   then open http://localhost:8078
 *
 * app_id: custom_hud (the default, the 800x480 HUD) and / or custom_cluster (the 1920x720 cluster). Several apps run
 * together, as on the car: each its own process and connection to the one fake cluster-render, and the page draws each
 * app's target (its app.json config.target) with its own center-screen panel; the vehicle signals go to all of them.
 * The service's limits are modelled (cluster-render 0.4.2 and later): 64 layers per connection, 96 across every
 * connection and 32 MiB of pixel memory (our cluster-render fork's pixel_mib; upstream 16) with each image counted twice (always on; see bench/README.md). BENCH_LAYER_CAP
 * sets a lower cap to try a layout under, off by default.
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
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const path = require("path");
const { fork, execFileSync } = require("child_process");
const { takeBuildLock, BUILD_LOCK_WAIT_MS } = require("./build_lock");
// What the driver sees of each target (hood curve, BMW's gear box and belt light, the HUD window):
// one source of truth, shared with the app's layout check. The page gets it in the 'hello' event.
const visible = require("../shared/visible");
const shaderBudget = require("../tools/shader_budget"); // what the KOMBI took on the car (texture reads, size)
const etc2 = require("../tools/etc2"); // etc2rgba assets, decoded for the page

/** @typedef {import("./run-app").ToApp} ToApp */
/** @typedef {import("./run-app").FromApp} FromApp */
/** @typedef {{ v: number[], type: string | null }} BenchUniform */
/**
 * A layer or asset the fake cluster-render holds, keyed "conn:ref" in layers.
 * @typedef {object} BenchLayer
 * @property {string} key "conn:ref"
 * @property {number} conn
 * @property {number} ref
 * @property {string} app the name in the connection's hello
 * @property {string} kind "image", "effect" or "asset" (others are registered, not drawn)
 * @property {string} target
 * @property {string} class
 * @property {number} z
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} visible
 * @property {number} opacity
 * @property {number} exclusive
 * @property {Record<string, BenchUniform>} uniforms
 * @property {"shown" | "waiting"} state
 * @property {string} reason
 * @property {number} [iw] image or asset width
 * @property {number} [ih]
 * @property {number} [bpp] bytes a pixel: 4, or 1 for an r8 asset
 * @property {Buffer} [image] image or asset pixels
 * @property {string} [format] asset only: "r8", "rgba8" or "etc2rgba"
 * @property {number} [readyAt] asset only: when its bytes are up (Date.now() ms), at the car's upload rate
 * @property {number} [memBpp] bytes a pixel in the service's pixel memory, when not bpp (etc2rgba: 1; its image here is
 *   the decoded RGBA, for the page)
 * @property {string} [fs] effect only: the fragment shader
 * @property {boolean} [time] effect only: the renderer's clock in u_time
 * @property {Record<string, string>} [binds] effect only: sampler name to asset key
 * @property {boolean} [sentWhole] the page has had the whole image
 */
/**
 * A layer as the page gets it in the 'scene' event: no pixels, with its visibility warnings.
 * @typedef {Omit<BenchLayer, "image" | "bpp" | "sentWhole"> & { warnings: string[] }} SceneLayer
 */
/**
 * One app the bench runs.
 * @typedef {object} BenchApp
 * @property {string} id
 * @property {string} dir apps/<id>
 * @property {string} data bench/.data/<id>, the app's data folder
 * @property {string} stage dist/<id>, the built app
 * @property {import("child_process").ChildProcess | null} child
 * @property {boolean} stopping
 * @property {NodeJS.Timeout | null} restartTimer
 * @property {FromApp | null} lastSettings
 * @property {FromApp | null} lastStatus
 */
/**
 * An event on the page's stream (GET /events), named by t: hello, log, scene, px, app, values, settings, status, nav,
 * assist or car.
 * @typedef {{ t: string, [field: string]: any }} PageEvent
 */
/**
 * A JSON op from an app's cluster-render client; which fields are set depends on op.
 * @typedef {object} RenderOp
 * @property {string} op hello, layer, asset, bind, set, drop, uniform or status
 * @property {number} ref
 * @property {string} [app] hello
 * @property {number} [proto] hello
 * @property {string} [kind]
 * @property {string} [target]
 * @property {string} [class]
 * @property {number} [z]
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [w]
 * @property {number} [h]
 * @property {number} [visible]
 * @property {number} [opacity]
 * @property {number} [exclusive]
 * @property {number} [iw]
 * @property {number} [ih]
 * @property {string} [fs]
 * @property {boolean} [time]
 * @property {string} [format]
 * @property {number} [asset] bind: the asset's ref
 * @property {string} [sampler] bind
 * @property {string} [name] uniform
 * @property {string} [v] uniform: numbers separated by spaces
 * @property {string} [type] uniform
 */

const DEFAULT_PORT = 8078; // the page's port without BENCH_PORT
const PORT = Number(process.env.BENCH_PORT) || DEFAULT_PORT;
// BENCH_LAYER_CAP: a lower per-connection cap to try a layout under (cluster-render before 0.4.2 drew 8; photos, Nov 5
// 2026). 0 = off. Layers past the cap get state 'waiting' and are not drawn. POST /cap sets it live.
let layerCap = Math.max(0, Number(process.env.BENCH_LAYER_CAP) || 0);
// The service's own limits, always on (CompositorLimits, 0.4.2 and later): 64 layers a connection and 96 across every
// connection ("too many layers"), and 32 MiB of
// pixel memory for every image together (the fork's pixel_mib default; upstream cluster-render keeps a fixed 16),
// each image counted twice (Compositor::add_image), refused with the service's own words "the service's pixel memory
// is full". BENCH_PIXEL_MIB overrides the 32 (16 = upstream's; 0 = unlimited).
const TOTAL_LAYERS = 96,
  LAYERS_PER_CLIENT = 64;
const MIB = 1024 * 1024;
const DEFAULT_PIXEL_MIB = 32; // the fork's pixel_mib
const PIXEL_COPIES = 2; // each image counted twice
const PIXEL_BYTES =
  (process.env.BENCH_PIXEL_MIB === undefined
    ? DEFAULT_PIXEL_MIB
    : Math.max(0, Number(process.env.BENCH_PIXEL_MIB) || 0)) * MIB;
// the service's accounting: an image or asset costs its bytes twice (compositor.cpp: the pixels and a rectangle scratch)
/** @returns {number} */
function pixelBytes() {
  let bytes = 0;
  layers.forEach((layer) => {
    if (layer.image)
      // an etc2rgba asset is charged its bytes once (cluster-render keeps no rectangle scratch for it), others twice
      bytes += layer.iw * layer.ih * (layer.memBpp || layer.bpp || 4) * (layer.format === "etc2rgba" ? 1 : PIXEL_COPIES);
  });
  return bytes;
}
/**
 * Layers, not counting assets.
 * @returns {number}
 */
function layerCount() {
  let count = 0;
  layers.forEach((layer) => {
    if (layer.kind !== "asset") count++;
  });
  return count;
}
const TOTAL_ASSETS = 32,
  ASSETS_PER_CLIENT = 16; // CompositorLimits assets / assets_per_client
/**
 * @param {number} bytes bytes
 * @returns {string}
 */
const mib = (bytes) => (bytes / MIB).toFixed(1) + " MiB";
const SOCK = path.join(os.tmpdir(), "hud-bench-" + process.pid + ".sock");
const ROOT = path.join(__dirname, "..");
const APP_IDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [process.env.BENCH_APP || "custom_hud"];
// one entry per app: its folders (data/ on the bench: settings.json, layouts/), its process and what it last reported
/** @type {BenchApp[]} */
const apps = APP_IDS.map((id) => {
  const dir = path.join(ROOT, "apps", id);
  if (!fs.existsSync(path.join(dir, "app.json"))) {
    console.error("no app " + id + " under apps/");
    process.exit(2);
  }
  return {
    id,
    dir,
    data: path.join(__dirname, ".data", id),
    stage: path.join(ROOT, "dist", id),
    child: null,
    stopping: false,
    restartTimer: null,
    lastSettings: null,
    lastStatus: null,
  };
});
/**
 * @param {string} id
 * @returns {BenchApp | null}
 */
const appOf = (id) => apps.find((app) => app.id === id) || null;
/** @type {Record<string, [number, number]>} target name to [w, h] */
const TARGETS = { hud: [800, 480], map: [1088, 480], panel: [1920, 720] };
const CLASSES = ["ambient", "content", "overlay", "alert"];
// the wire (PROTOCOL.md; shared/cluster_render_client.js): a 4 byte length, then a type byte and the body
const LEN_BYTES = 4,
  HEAD_BYTES = 5;
const JSON_T = 0x4a, // 'J'
  FRAME_T = 0x46, // 'F'
  MESH_T = 0x4d; // 'M'
const PROTO = 1; // the protocol version the service speaks
const MAX_IMAGE_W = 1920,
  MAX_IMAGE_H = 720; // an image layer's largest size, the panel's
const MSG_SLACK = 64; // room past a whole frame's pixels for its header
const MAX_MSG = MAX_IMAGE_W * MAX_IMAGE_H * 4 + MSG_SLACK; // 5529664
const Z_MAX = 1000; // a layer's z runs -Z_MAX..Z_MAX
const MAX_ASSET_SIDE = 2048;
const MAX_UNIFORM_NUMBERS = 1024, // a typed (array) uniform
  MAX_UNTYPED_NUMBERS = 4,
  MAX_UNIFORMS = 32; // names a layer, u_time among them (Uniforms::kMaxNames)
// a 'F' message: ref at 0, the rect count at 12, then from 14 a rect each 8 bytes (x, y, w, h as uint16)
const RECT_COUNT_AT = 12,
  FRAME_HEAD = 14,
  RECT_BYTES = 8;
// The car runs Node 8.16.2, so run the app on that by default when it's in the drive cache.
const NODE8 = path.join(
  ROOT,
  "..",
  "..",
  ".cache",
  "node8",
  "node-v8.16.2-darwin-x64",
  "bin",
  "node",
);
const APP_NODE =
  process.env.BENCH_NODE || (fs.existsSync(NODE8) ? NODE8 : null);
/**
 * The target the page draws for an app: its config.target (read again on each restart).
 * @param {BenchApp} app
 * @returns {string}
 */
function appView(app) {
  try {
    const target = JSON.parse(
      fs.readFileSync(path.join(app.dir, "app.json"), "utf8"),
    ).config.target;
    return TARGETS[target] ? target : "hud";
  } catch (err) {
    return "hud";
  }
}

/* ---------- browser side: Server-Sent Events out, small POSTs in ---------- */

/** @type {Set<http.ServerResponse>} the open event streams */
const clients = new Set();
const LOG_KEEP = 400; // log events replayed to a new page
/** @type {PageEvent[]} the last LOG_KEEP log events, replayed to a new page */
const logLines = [];
/**
 * An event to every page, or only to one.
 * @param {PageEvent} obj
 * @param {http.ServerResponse} [only]
 */
function send(obj, only) {
  const line = "data: " + JSON.stringify(obj) + "\n\n";
  (only ? [only] : Array.from(clients)).forEach((res) => res.write(line));
}
/**
 * @param {"info" | "warn" | "error"} level
 * @param {string} text
 */
function log(level, text) {
  const entry = {
    t: "log",
    level,
    text: new Date().toTimeString().slice(0, 8) + "  " + text,
  };
  logLines.push(entry);
  if (logLines.length > LOG_KEEP) logLines.shift();
  send(entry);
  (level === "error" ? console.error : console.log)(entry.text);
}

/* ---------- the fake cluster-render ---------- */

/** @type {Map<string, BenchLayer>} */
const layers = new Map(); // key "conn:ref" -> layer
let nextConn = 1;

/**
 * The visibility warnings for one layer's rect on its target (the same check layouts.js runs per widget).
 * @param {BenchLayer} layer
 * @returns {string[]}
 */
function layerWarnings(layer) {
  return visible
    .check(
      [{ id: "#" + layer.ref, x: layer.x, y: layer.y, w: layer.w, h: layer.h }],
      layer.target === "panel" ? "panel" : "hud",
    )
    .map((warning) => warning.replace(/^#\d+: /, ""));
}
/**
 * Layers waiting over the layer cap.
 * @returns {number}
 */
function overCap() {
  return Array.from(layers.values()).filter(
    (layer) => layer.state === "waiting",
  ).length;
}
/** @returns {SceneLayer[]} */
function sceneMeta() {
  return Array.from(layers.values()).map((layer) => ({
    key: layer.key,
    conn: layer.conn,
    ref: layer.ref,
    app: layer.app,
    kind: layer.kind,
    target: layer.target,
    class: layer.class,
    z: layer.z,
    x: layer.x,
    y: layer.y,
    w: layer.w,
    h: layer.h,
    visible: layer.visible,
    opacity: layer.opacity,
    exclusive: layer.exclusive,
    iw: layer.iw,
    ih: layer.ih,
    fs: layer.fs,
    time: layer.time,
    uniforms: layer.uniforms,
    binds: layer.binds,
    format: layer.format,
    state: layer.state,
    reason: layer.reason,
    budget: layer.budget,
    warnings: layer.kind === "asset" ? [] : layerWarnings(layer),
  }));
}
/**
 * The 'hello' event: targets, apps, caps and the visibility geometry.
 * @returns {PageEvent}
 */
function helloMsg() {
  return {
    shaderBudget: {
      readsGood: shaderBudget.READS_GOOD,
      readsCrash: shaderBudget.READS_CRASH,
      tokensGood: shaderBudget.TOKENS_GOOD,
      tokensCrash: shaderBudget.TOKENS_CRASH,
      lookupsGood: shaderBudget.LOOKUPS_GOOD,
      lookupsCrash: shaderBudget.LOOKUPS_CRASH,
    },
    t: "hello",
    targets: TARGETS,
    apps: apps.map((app) => ({ id: app.id, view: appView(app) })),
    view: appView(apps[0]),
    app: APP_IDS.join(" + "),
    cap: layerCap,
    pixelCap: PIXEL_BYTES,
    geometry: {
      HOOD: visible.HOOD,
      CAMERA: visible.CAMERA,
      BLACK_BOX: visible.BLACK_BOX,
      BELT: visible.BELT,
      GEAR: visible.GEAR,
      HUD_WINDOW: visible.HUD_WINDOW,
    },
  };
}
/** @type {NodeJS.Timeout | null} */
let sceneTimer = null;
const SCENE_MS = 16; // the scene goes to the pages at most this often
/** Sends the scene to the pages, at most every SCENE_MS. */
function sceneChanged() {
  if (sceneTimer) return;
  sceneTimer = setTimeout(() => {
    sceneTimer = null;
    send({ t: "scene", layers: sceneMeta(), pixels: pixelBytes() });
  }, SCENE_MS);
}
/* Pixels never travel on the event stream: a 'px' notice names a rect of an image layer and the page fetches its
 * bytes from GET /px (binary, the layer's current pixels). Base64 on the stream choked the page once the engine
 * packed text into 1 MB sheets (Nov 5 2026). */
/**
 * @param {BenchLayer} layer
 * @param {http.ServerResponse} [only]
 */
function sendPixels(layer, only) {
  if (!layer.image) return;
  sendRect(layer, 0, 0, layer.iw, layer.ih, only);
}
/**
 * @param {BenchLayer} layer
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {http.ServerResponse} [only]
 */
function sendRect(layer, x, y, w, h, only) {
  send(
    { t: "px", key: layer.key, iw: layer.iw, ih: layer.ih, x, y, w, h },
    only,
  );
}
/**
 * GET /px?key=&x=&y=&w=&h=: that rect of the layer's image, raw RGBA rows.
 * @param {Record<string, string>} query the query
 * @returns {Buffer | null} null for an unknown layer or a rect off its image
 */
function pixelRect(query) {
  const layer = layers.get(query.key);
  const x = Number(query.x),
    y = Number(query.y),
    w = Number(query.w),
    h = Number(query.h);
  if (
    !layer ||
    !layer.image ||
    !(
      w > 0 &&
      h > 0 &&
      x >= 0 &&
      y >= 0 &&
      x + w <= layer.iw &&
      y + h <= layer.ih
    )
  )
    return null;
  if (layer.bpp === 1) {
    // an R8 asset: the page gets it as RGBA, the byte in R (what a shader's .r reads) and A, grey in G and B
    const out = Buffer.alloc(w * h * 4);
    for (let row = 0; row < h; row++) {
      for (let i = 0; i < w; i++) {
        const value = layer.image[(y + row) * layer.iw + x + i],
          offset = (row * w + i) * 4;
        out[offset] = value;
        out[offset + 1] = value;
        out[offset + 2] = value;
        out[offset + 3] = value;
      }
    }
    return out;
  }
  if (x === 0 && w === layer.iw)
    return layer.image.slice(y * layer.iw * 4, (y + h) * layer.iw * 4);
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++)
    layer.image.copy(
      out,
      row * w * 4,
      ((y + row) * layer.iw + x) * 4,
      ((y + row) * layer.iw + x + w) * 4,
    );
  return out;
}

/**
 * An event to an app's connection, as a 'J' message.
 * @param {net.Socket} sock
 * @param {object} obj
 */
function writeEv(sock, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const packet = Buffer.alloc(HEAD_BYTES + body.length);
  packet.writeUInt32LE(body.length + 1, 0);
  packet[LEN_BYTES] = JSON_T;
  body.copy(packet, HEAD_BYTES);
  sock.write(packet);
}

const renderServer = net.createServer((sock) => {
  const conn = nextConn++;
  const session = { conn, app: "?", hello: false, buf: Buffer.alloc(0) };
  /** @param {string} why */
  const bad = (why) => {
    log("error", "protocol [" + session.app + "]: " + why);
  };
  /**
   * Logs it and sends the app an error event.
   * @param {string} op
   * @param {number} ref
   * @param {string} reason
   */
  const refuse = (op, ref, reason) => {
    bad(op + " ref " + ref + ": " + reason);
    writeEv(sock, { ev: "error", op, ref, reason });
  };

  sock.on("data", (chunk) => {
    session.buf = session.buf.length
      ? Buffer.concat([session.buf, chunk])
      : chunk;
    let off = 0;
    while (session.buf.length - off >= HEAD_BYTES) {
      const len = session.buf.readUInt32LE(off);
      if (len < 1 || len > MAX_MSG) {
        bad("message length " + len + " out of range, closing");
        sock.destroy();
        return;
      }
      if (session.buf.length - off < LEN_BYTES + len) break;
      const type = session.buf[off + LEN_BYTES];
      const body = session.buf.slice(off + HEAD_BYTES, off + LEN_BYTES + len);
      off += LEN_BYTES + len;
      try {
        handle(type, body);
      } catch (err) {
        bad("handler threw: " + err.stack);
      }
    }
    session.buf = session.buf.slice(off);
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    let dropped = 0;
    layers.forEach((layer, k) => {
      if (layer.conn === conn) {
        layers.delete(k);
        dropped++;
      }
    });
    log(
      "info",
      "renderer: " +
        session.app +
        " disconnected, dropped its " +
        dropped +
        " layer(s)",
    );
    sceneChanged();
  });

  /**
   * @param {number} type the message type byte
   * @param {Buffer} body
   * @returns {void}
   */
  function handle(type, body) {
    if (type === JSON_T) return onJson(body);
    if (!session.hello) return bad("binary message before hello");
    if (type === FRAME_T) return onFrame(body);
    if (type === MESH_T)
      return bad("mesh geometry received; the bench does not draw meshes");
    bad("unknown message type 0x" + type.toString(16));
  }

  /**
   * @param {Buffer} body
   * @returns {void}
   */
  function onJson(body) {
    /** @type {RenderOp} */
    let msg;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch (err) {
      return bad("JSON message does not parse: " + err.message);
    }
    if (msg.op === "hello") {
      session.hello = true;
      session.app = msg.app || "?";
      if (msg.proto !== PROTO)
        bad("hello proto " + msg.proto + ", service speaks " + PROTO);
      log(
        "info",
        "renderer: hello from " + session.app + " (proto " + msg.proto + ")",
      );
      writeEv(sock, {
        ev: "hello",
        backend: "bench",
        targets: Object.keys(TARGETS).join(","),
      });
      return;
    }
    if (!session.hello) return bad(msg.op + " before hello");
    const key = conn + ":" + msg.ref;
    const layer = layers.get(key);
    switch (msg.op) {
      case "layer": {
        if (!TARGETS[msg.target])
          return refuse("layer", msg.ref, "unknown target " + msg.target);
        if (msg.class && CLASSES.indexOf(msg.class) < 0)
          return refuse("layer", msg.ref, "unknown class " + msg.class);
        if (msg.z !== undefined && (msg.z < -Z_MAX || msg.z > Z_MAX))
          return refuse("layer", msg.ref, "z out of -" + Z_MAX + ".." + Z_MAX);
        const [targetW, targetH] = TARGETS[msg.target];
        let mineL = 0;
        layers.forEach((other) => {
          if (other.conn === conn && other.kind !== "asset") mineL++;
        });
        if (layerCount() >= TOTAL_LAYERS || mineL >= LAYERS_PER_CLIENT)
          return refuse("layer", msg.ref, "too many layers");
        if (
          msg.kind === "image" &&
          PIXEL_BYTES &&
          msg.iw > 0 &&
          msg.ih > 0 &&
          pixelBytes() + msg.iw * msg.ih * 4 * PIXEL_COPIES > PIXEL_BYTES
        ) {
          return refuse("layer", msg.ref, "the service's pixel memory is full");
        }
        /** @type {BenchLayer} */
        const newLayer = {
          key,
          conn,
          ref: msg.ref,
          app: session.app,
          kind: msg.kind,
          target: msg.target,
          class: msg.class || "content",
          z: msg.z || 0,
          x: msg.x || 0,
          y: msg.y || 0,
          w: msg.w || 0,
          h: msg.h || 0,
          visible: msg.visible === undefined ? 1 : msg.visible,
          opacity: msg.opacity === undefined ? 1 : msg.opacity,
          exclusive: msg.exclusive || 0,
          uniforms: {},
          state: "shown",
          reason: "",
        };
        // The layer cap: count this connection's live layers that got a slot; past the cap, the
        // layer is registered (so set/uniform/frames on it stay valid) but waits and is not drawn.
        if (layerCap > 0) {
          let shown = 0,
            live = 0;
          layers.forEach((other) => {
            if (other.conn === conn && other.kind !== "asset") {
              live++;
              if (other.state === "shown") shown++;
            }
          });
          if (shown >= layerCap) {
            newLayer.state = "waiting";
            newLayer.reason = "bench: over the layer cap of " + layerCap;
            log(
              "warn",
              "layer " +
                msg.ref +
                " (" +
                msg.kind +
                " " +
                newLayer.x +
                "," +
                newLayer.y +
                " " +
                newLayer.w +
                "x" +
                newLayer.h +
                ") is live layer #" +
                (live + 1) +
                " on this connection: over the layer cap of " +
                layerCap +
                ", not drawn",
            );
          }
        }
        if (
          newLayer.x + newLayer.w > targetW ||
          newLayer.y + newLayer.h > targetH ||
          newLayer.x < 0 ||
          newLayer.y < 0
        ) {
          log(
            "warn",
            "layer " +
              msg.ref +
              " (" +
              newLayer.x +
              "," +
              newLayer.y +
              " " +
              newLayer.w +
              "x" +
              newLayer.h +
              ") runs off the " +
              targetW +
              "x" +
              targetH +
              " " +
              msg.target +
              " target",
          );
        }
        if (newLayer.exclusive)
          log(
            "warn",
            "layer " +
              msg.ref +
              " is exclusive: it hides everything under it (CarPlay/AA map too)",
          );
        if (msg.kind === "image") {
          newLayer.iw = msg.iw;
          newLayer.ih = msg.ih;
          newLayer.bpp = 4;
          if (
            !(
              msg.iw > 0 &&
              msg.ih > 0 &&
              msg.iw <= MAX_IMAGE_W &&
              msg.ih <= MAX_IMAGE_H
            )
          )
            return refuse("layer", msg.ref, "image iw/ih out of range");
          newLayer.image = Buffer.alloc(msg.iw * msg.ih * 4);
        } else if (msg.kind === "effect") {
          if (!msg.fs) return refuse("layer", msg.ref, "effect without fs");
          // shaders that crashed the car's KOMBI (38 texture reads, Custom HUD 0.1.15; 8724 tokens, the M theme; 48
          // uniform-array lookup steps, Custom HUD 0.1.30/0.1.31): refused here first
          const budget = shaderBudget.check(msg.fs);
          if (budget.level === "crash")
            return refuse("layer", msg.ref, "shader " + budget.text);
          if (budget.level === "warn")
            log("warn", "layer " + msg.ref + ": shader " + budget.text);
          newLayer.fs = msg.fs;
          newLayer.budget = {
            reads: budget.reads,
            tokens: budget.tokens,
            lookups: budget.lookups,
            level: budget.level,
          };
          newLayer.time = !!msg.time;
          newLayer.binds = {};
        } else {
          log(
            "warn",
            "layer " +
              msg.ref +
              ": kind " +
              msg.kind +
              " is not drawn by the bench",
          );
        }
        layers.set(key, newLayer); // its visibility warnings (hood, gear box, belt light, HUD window) ride along in sceneMeta()
        if (newLayer.state === "waiting")
          writeEv(sock, {
            ev: "layer",
            ref: msg.ref,
            state: "waiting",
            reason: newLayer.reason,
          });
        else writeEv(sock, { ev: "layer", ref: msg.ref, state: "shown" });
        sceneChanged();
        return;
      }
      case "asset": {
        // PROTOCOL.md "asset": an R8 or RGBA8 texture, not drawn, not a layer; effect layers sample it through "bind".
        // Also etc2rgba (cluster-render 0.5.9): ETC2 RGBA, 4x4 blocks of 16 bytes, sent whole; kept here decoded
        // (tools/etc2.js) so the page draws it as the car does.
        // The service's limits: 32 assets, 16 per client, 1..2048 a side, within one frame message; pixel memory twice its bytes.
        if (!TARGETS[msg.target])
          return refuse("asset", msg.ref, "unknown target " + msg.target);
        const format = msg.format || "rgba8",
          etc2Asset = format === "etc2rgba",
          bpp = format === "r8" ? 1 : format === "rgba8" || etc2Asset ? 4 : 0,
          memBpp = etc2Asset ? 1 : bpp;
        if (!bpp)
          return refuse("asset", msg.ref, "unknown asset format " + format);
        if (etc2Asset && (msg.w % etc2.BLOCK || msg.h % etc2.BLOCK))
          return refuse("asset", msg.ref, "etc2rgba: w and h must be multiples of 4");
        if (!(
          msg.w > 0 &&
          msg.h > 0 &&
          msg.w <= MAX_ASSET_SIDE &&
          msg.h <= MAX_ASSET_SIDE &&
          msg.w * msg.h * memBpp + MSG_SLACK <= MAX_MSG
        ))
          return refuse("asset", msg.ref, "asset size out of range");
        let all = 0,
          mine = 0;
        layers.forEach((other) => {
          if (other.kind === "asset") {
            all++;
            if (other.conn === conn) mine++;
          }
        });
        if (all >= TOTAL_ASSETS || mine >= ASSETS_PER_CLIENT)
          return refuse("asset", msg.ref, "too many assets");
        if (
          PIXEL_BYTES &&
          pixelBytes() + msg.w * msg.h * memBpp * (etc2Asset ? 1 : PIXEL_COPIES) > PIXEL_BYTES
        )
          return refuse("asset", msg.ref, "the service's pixel memory is full");
        layers.set(key, {
          key,
          conn,
          ref: msg.ref,
          app: session.app,
          kind: "asset",
          target: msg.target,
          format,
          bpp,
          memBpp,
          class: "-",
          z: 0,
          x: 0,
          y: 0,
          w: msg.w,
          h: msg.h,
          iw: msg.w,
          ih: msg.h,
          visible: 0,
          opacity: 1,
          exclusive: 0,
          uniforms: {},
          image: Buffer.alloc(msg.w * msg.h * bpp),
          state: "shown",
          reason: "",
        });
        log(
          "info",
          "asset " +
            msg.ref +
            ": " +
            format +
            " " +
            msg.w +
            "x" +
            msg.h +
            " (" +
            mib(msg.w * msg.h * memBpp * (etc2Asset ? 1 : PIXEL_COPIES)) +
            " of pixel memory)",
        );
        writeEv(sock, { ev: "layer", ref: msg.ref, state: "shown" });
        sceneChanged();
        return;
      }
      case "bind": {
        if (!layer) return refuse("bind", msg.ref, "no such layer");
        if (layer.kind !== "effect")
          return refuse("bind", msg.ref, "bind on a " + layer.kind + " layer");
        const asset = layers.get(conn + ":" + msg.asset);
        if (!asset || asset.kind !== "asset")
          return refuse("bind", msg.ref, "no such asset " + msg.asset);
        if (asset.target !== layer.target)
          return refuse("bind", msg.ref, "the asset is on another target");
        layer.binds[msg.sampler] = asset.key;
        holdSamplers(asset);
        sceneChanged();
        return;
      }
      case "set": {
        if (!layer) return refuse("set", msg.ref, "no such layer");
        [
          "class",
          "z",
          "x",
          "y",
          "w",
          "h",
          "visible",
          "exclusive",
          "opacity",
        ].forEach((k) => {
          if (msg[k] !== undefined) layer[k] = msg[k];
        });
        sceneChanged();
        return;
      }
      case "drop": {
        if (!layer) return refuse("drop", msg.ref, "no such layer");
        if (layer.kind === "asset") {
          let used = false;
          layers.forEach((other) => {
            if (
              other.binds &&
              Object.keys(other.binds).some(
                (sampler) => other.binds[sampler] === key,
              )
            )
              used = true;
          });
          if (used) return refuse("drop", msg.ref, "asset in use");
        }
        layers.delete(key);
        sceneChanged();
        return;
      }
      case "uniform": {
        if (!layer) return refuse("uniform", msg.ref, "no such layer");
        if (layer.kind !== "effect")
          return refuse(
            "uniform",
            msg.ref,
            "uniform on a " + layer.kind + " layer",
          );
        const values = String(msg.v).trim().split(/\s+/).map(Number);
        if (values.some((num) => !isFinite(num)))
          return refuse(
            "uniform",
            msg.ref,
            'non-numeric value "' + msg.v + '"',
          );
        // PROTOCOL.md "Uniforms": without type, 1-4 numbers; with type, whole elements, up to 1024
        // numbers (an array uniform). Both the numbers and the type reach the page.
        /** @type {Record<string, number>} */
        const WIDTH = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat4: 16 };
        if (msg.type !== undefined) {
          if (!WIDTH[msg.type])
            return refuse(
              "uniform",
              msg.ref,
              'unknown uniform type "' + msg.type + '"',
            );
          if (
            values.length > MAX_UNIFORM_NUMBERS ||
            values.length % WIDTH[msg.type]
          )
            return refuse(
              "uniform",
              msg.ref,
              "uniform " +
                msg.name +
                ": " +
                values.length +
                " numbers is not whole " +
                msg.type +
                "s (or over " +
                MAX_UNIFORM_NUMBERS +
                ")",
            );
        } else if (values.length > MAX_UNTYPED_NUMBERS)
          return refuse(
            "uniform",
            msg.ref,
            "uniform " +
              msg.name +
              ": " +
              values.length +
              " numbers without a type (max " +
              MAX_UNTYPED_NUMBERS +
              ")",
          );
        // the car's cluster-render keeps at most 32 uniform names a layer (Uniforms::kMaxNames, 0.4.5), u_time among
        // them on a layer with the renderer's clock, and refuses a new one past that (Custom HUD 0.1.9's Miku sent 34
        // and the car refused it, Nov 8 2026; the bench had let it through)
        const maxU = MAX_UNIFORMS - (layer.time ? 1 : 0);
        if (
          !layer.uniforms[msg.name] &&
          Object.keys(layer.uniforms).length >= maxU
        )
          return refuse(
            "uniform",
            msg.ref,
            "at most " + MAX_UNIFORMS + " uniforms a layer",
          );
        layer.uniforms[msg.name] = { v: values, type: msg.type || null };
        sceneChanged();
        return;
      }
      case "status":
        const conns = new Set(
          Array.from(layers.values()).map((layer) => layer.conn),
        ).size;
        const assets = layers.size - layerCount();
        writeEv(sock, {
          ev: "status",
          text:
            "bench: " +
            layerCount() +
            " layers" +
            (assets
              ? " and " + assets + " asset" + (assets > 1 ? "s" : "")
              : "") +
            " on " +
            conns +
            " connection(s), layer cap " +
            (layerCap || "off") +
            ", " +
            overCap() +
            " over it, pixel memory " +
            mib(pixelBytes()) +
            " of " +
            (PIXEL_BYTES ? mib(PIXEL_BYTES) : "unlimited"),
        });
        return;
      default:
        bad('op "' + msg.op + '" not handled by the bench');
    }
  }

  /**
   * A 'F' message: a whole image, or dirty rects, for an image layer or an asset.
   * @param {Buffer} body
   * @returns {void}
   */
  /**
   * The effect layers on this connection sampling an asset still going up: waiting until it is, then shown.
   * @param {BenchLayer} asset
   */
  // A safety net under holdSamplers' timers: once a second, a layer still held for an asset that is up by now is shown
  // (a Miku close-up layer once stayed "not written yet" with all three of its textures up; not reproduced since)
  const unheld = setInterval(() => {
    layers.forEach((other) => {
      if (other.conn !== conn || other.state !== "waiting" || other.reason !== NOT_WRITTEN) return;
      const pending = Object.keys(other.binds || {}).some((sampler) => {
        const bound = layers.get(other.binds[sampler]);
        return bound && (bound.readyAt || 0) > Date.now();
      });
      if (pending) return;
      other.state = "shown";
      other.reason = "";
      writeEv(sock, { ev: "layer", ref: other.ref, state: "shown" });
      sceneChanged();
    });
  }, 1000);
  sock.on("close", () => clearInterval(unheld));

  function holdSamplers(asset) {
    const left = (asset.readyAt || 0) - Date.now();
    if (left <= 0) return;
    /** @type {BenchLayer[]} */
    const held = [];
    layers.forEach((other) => {
      if (other.conn !== conn || !other.binds) return;
      if (!Object.keys(other.binds).some((sampler) => other.binds[sampler] === asset.key)) return;
      // already held for another of its assets: this one's timer releases it too (whichever is up last)
      if (other.state === "waiting" && other.reason === NOT_WRITTEN) return void held.push(other);
      if (other.state !== "shown") return; // waiting for something else (the layer cap): left as it is
      other.state = "waiting";
      other.reason = NOT_WRITTEN;
      writeEv(sock, { ev: "layer", ref: other.ref, state: "waiting", reason: NOT_WRITTEN });
      held.push(other);
    });
    if (!held.length) return;
    sceneChanged();
    setTimeout(() => {
      held.forEach((other) => {
        if (other.state !== "waiting" || other.reason !== NOT_WRITTEN || layers.get(other.key) !== other) return;
        // still another asset of its going up: it waits for that one's timer
        const pending = Object.keys(other.binds || {}).some((sampler) => {
          const bound = layers.get(other.binds[sampler]);
          return bound && (bound.readyAt || 0) > Date.now();
        });
        if (pending) return;
        other.state = "shown";
        other.reason = "";
        writeEv(sock, { ev: "layer", ref: other.ref, state: "shown" });
      });
      sceneChanged();
    }, left + 1);
  }

  function onFrame(body) {
    if (body.length < FRAME_HEAD) return bad("frame message too short");
    const ref = body.readUInt32LE(0);
    const rectCount = body.readUInt16LE(RECT_COUNT_AT);
    const layer = layers.get(conn + ":" + ref);
    if (!layer) return bad("frame for unknown ref " + ref);
    if (layer.kind !== "image" && layer.kind !== "asset")
      return bad("frame for a " + layer.kind + " layer (ref " + ref + ")");
    const head = FRAME_HEAD + rectCount * RECT_BYTES,
      bpp = layer.bpp || 4;
    const pixels = body.slice(head);
    if (layer.format === "etc2rgba") {
      if (rectCount) return bad("etc2rgba asset ref " + ref + ": whole only, no rects");
      if (pixels.length !== etc2.etc2Bytes(layer.iw, layer.ih))
        return bad(
          "etc2rgba ref " + ref + " is " + pixels.length + " bytes, " + layer.iw + "x" + layer.ih + " needs " +
            etc2.etc2Bytes(layer.iw, layer.ih),
        );
      etc2.decode(pixels, layer.iw, layer.ih).copy(layer.image);
    } else if (rectCount === 0) {
      if (pixels.length !== layer.image.length)
        return bad(
          "whole frame for ref " +
            ref +
            " is " +
            pixels.length +
            " bytes, layer needs " +
            layer.image.length,
        );
      pixels.copy(layer.image);
    } else {
      let offset = 0;
      /** @type {number[][]} [x, y, w, h] */
      const rects = [];
      for (let i = 0; i < rectCount; i++) {
        const at = FRAME_HEAD + i * RECT_BYTES;
        const x = body.readUInt16LE(at),
          y = body.readUInt16LE(at + 2);
        const w = body.readUInt16LE(at + 4),
          h = body.readUInt16LE(at + 6);
        if (x + w > layer.iw || y + h > layer.ih)
          return bad("dirty rect off the image on ref " + ref);
        for (let row = 0; row < h; row++) {
          pixels.copy(
            layer.image,
            ((y + row) * layer.iw + x) * bpp,
            offset,
            offset + w * bpp,
          );
          offset += w * bpp;
        }
        rects.push([x, y, w, h]);
      }
      if (offset !== pixels.length)
        return bad(
          "dirty rects for ref " +
            ref +
            " carry " +
            pixels.length +
            " bytes, expected " +
            offset,
        );
      if (layer.sentWhole) {
        rects.forEach((rect) =>
          sendRect(layer, rect[0], rect[1], rect[2], rect[3]),
        );
        return;
      }
    }
    layer.sentWhole = true;
    if (layer.kind === "asset" && UPLOAD_BYTES_PER_MS) {
      const start = Math.max(Date.now(), uploadFreeAt);
      layer.readyAt = uploadFreeAt = start + pixels.length / UPLOAD_BYTES_PER_MS;
      holdSamplers(layer);
    }
    sendPixels(layer);
  }
});

/* ---------- the app children ---------- */

/** @type {Extract<ToApp, { t: "signals" }>} */
let signals = { t: "signals", mode: "demo", values: {} };
/** @type {Extract<ToApp, { t: "drive" }>} */
let drive = { t: "drive", value: null }; // the drive mode buttons (FES actualValueModeDrivingExperience), null = car hasn't said
/** @type {Extract<ToApp, { t: "nav" }>} */
let nav = { t: "nav", value: null }; // route guidance (Guidance guidanceState: 'ACTIVE', 'INACTIVE'), null = car hasn't said
/** @type {Record<string, string>} */
let carSw = {}; // the car switches (page "Car switches": turn signals, brake lights, parking brake, ...), key -> value
/** @type {Extract<ToApp, { t: "assist" }>} */
let assist = { t: "assist", value: null }; // BMW's HUD driver assistance block (DisplayDataServer): 'acc' or 'off', null = car hasn't said
/**
 * A message to every running app (the vehicle signals are the car's, so every app gets them).
 * @param {ToApp} msg
 */
function toApps(msg) {
  apps.forEach((app) => {
    if (app.child) app.child.send(msg);
  });
}

/**
 * Builds dist/<id> with kit/tools/build.py.
 * @param {BenchApp} app
 * @returns {boolean} whether it built
 */
function build(app) {
  // The kit's build needs an oap-sdk folder; on the Mac that is a stub (see bench/README.md).
  const sdk = path.join(ROOT, "oap-sdk");
  if (!fs.existsSync(path.join(sdk, "index.js"))) {
    fs.mkdirSync(sdk, { recursive: true });
    fs.writeFileSync(
      path.join(sdk, "index.js"),
      "'use strict';\n// BENCH_STUB: stands in for BMW's oap-sdk so kit/tools/build.py runs on the Mac. Never ship this.\nthrow new Error('BENCH_STUB oap-sdk');\n",
    );
    fs.writeFileSync(
      path.join(sdk, "package.json"),
      JSON.stringify({
        name: "oap-sdk",
        version: "0.0.0-bench-stub",
        main: "index.js",
      }) + "\n",
    );
  }
  // Every bench running on this repo builds into the same dist/<id>/ (two benches, e.g. "bench" and "bench-hud",
  // both rebuild an app when one of its files is saved), so a build holds a lock other benches wait for.
  const lock = takeBuildLock(path.join(ROOT, "dist"), app.id, (level, text) =>
    log(level, text),
  );
  if (!lock) {
    log(
      "error",
      "build " +
        app.id +
        ": another bench has been building it for over " +
        BUILD_LOCK_WAIT_MS / 1000 +
        " s; restart to try again",
    );
    return false;
  }
  try {
    const out = execFileSync(
      "python3",
      [path.join(ROOT, "kit", "tools", "build.py"), app.id],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    String(out)
      .split("\n")
      .filter(Boolean)
      .forEach((line) => log("info", "build " + app.id + ": " + line.trim()));
    return true;
  } catch (err) {
    log(
      "error",
      "build " +
        app.id +
        " failed: " +
        String(err.stderr || err.message).trim(),
    );
    return false;
  } finally {
    lock();
  }
}

/**
 * Builds the app and forks run-app.js on it.
 * @param {BenchApp} app
 */
function startApp(app) {
  try {
    fs.mkdirSync(app.data, { recursive: true });
  } catch (err) {
    /* there */
  }
  send(helloMsg());
  if (!build(app)) {
    send({ t: "app", app: app.id, state: "stopped" });
    return;
  }
  /** @type {import("child_process").ForkOptions} */
  const opts = {
    cwd: app.data,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: Object.assign({}, process.env, { HUD_CLUSTER_SOCKET: SOCK }),
  };
  if (APP_NODE) opts.execPath = APP_NODE;
  const child = (app.child = fork(
    path.join(__dirname, "run-app.js"),
    [app.stage, app.data],
    opts,
  ));
  if (drive.value !== null) child.send(drive);
  if (nav.value !== null) child.send(nav);
  if (assist.value !== null) child.send(assist);
  Object.keys(carSw).forEach((k) =>
    child.send({ t: "car", key: k, value: carSw[k] }),
  );
  /**
   * The child's output into the log, line by line.
   * @param {import("stream").Readable} stream
   * @param {"info" | "warn"} level
   */
  const pipe = (stream, level) => {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      lines.forEach(
        (line) =>
          line &&
          log(/WARN|Error|error/.test(line) ? "warn" : level, "app: " + line),
      );
    });
  };
  pipe(child.stdout, "info");
  pipe(child.stderr, "warn");
  child.on(
    "message",
    /** @param {FromApp} msg */ (msg) => {
      if (!msg) return;
      msg.app = app.id;
      if (msg.t === "settings") app.lastSettings = msg;
      if (msg.t === "status") {
        app.lastStatus = msg;
        log(
          "info",
          "center screen status [" +
            app.id +
            "]: " +
            msg.s +
            (msg.d ? " / " + msg.d : ""),
        );
      }
      if (msg.t === "values" || msg.t === "settings" || msg.t === "status")
        send(msg);
    },
  );
  child.on("exit", (code, sig) => {
    if (child !== app.child) return;
    app.child = null;
    send({ t: "app", app: app.id, state: "stopped" });
    if (!app.stopping)
      log(
        "error",
        app.id +
          " exited (code " +
          code +
          (sig ? ", " + sig : "") +
          "); fix and save to restart",
      );
  });
  child.send(signals);
  send({ t: "app", app: app.id, state: "running" });
  log(
    "info",
    app.id +
      " started on " +
      (APP_NODE
        ? APP_NODE.replace(/^.*\/(node-v[^/]+)\/.*$/, "$1")
        : "node " + process.version + " (not the car's Node 8)"),
  );
}

const KILL_AFTER_MS = 1500; // SIGKILL an app that ignored SIGTERM this long
/**
 * @param {BenchApp} app
 * @param {string} why for the log
 */
function restartApp(app, why) {
  // already stopping the old one, with a start queued on its exit: a second start now would run the app twice
  if (app.stopping) {
    log("info", "restarting " + app.id + ": " + why + " (already restarting)");
    return;
  }
  log("info", "restarting " + app.id + ": " + why);
  if (app.child) {
    const old = app.child;
    app.child = null;
    app.stopping = true;
    old.once("exit", () => {
      app.stopping = false;
      startApp(app);
    });
    old.kill("SIGTERM");
    setTimeout(() => {
      try {
        old.kill("SIGKILL");
      } catch (err) {
        /* gone */
      }
    }, KILL_AFTER_MS);
  } else startApp(app);
}
/** @param {string} why */
const restartAll = (why) => apps.forEach((app) => restartApp(app, why));

// an app's own folder restarts that app; shared/ and kit/ restart them all
const RESTART_DEBOUNCE_MS = 300; // a burst of saves restarts once
/**
 * Restarts targets when a file under dir changes.
 * @param {string} dir
 * @param {BenchApp[]} targets
 * @returns {fs.FSWatcher}
 */
const watchFor = (dir, targets) =>
  fs.watch(dir, { recursive: true }, (event, file) => {
    if (!file || /(^|\/)\./.test(file) || /__pycache__/.test(file)) return;
    targets.forEach((app) => {
      clearTimeout(app.restartTimer);
      app.restartTimer = setTimeout(
        () => restartApp(app, path.basename(dir) + "/" + file + " changed"),
        RESTART_DEBOUNCE_MS,
      );
    });
  });
apps.forEach((app) => watchFor(app.dir, [app]));
[path.join(ROOT, "shared"), path.join(ROOT, "kit")].forEach((dir) =>
  watchFor(dir, apps),
);

/* ---------- HTTP ---------- */

const MAX_BODY_CHARS = 1e5; // a POST's JSON body
const MAX_SHOT_CHARS = 2e7; // a /shot PNG data URL
const MAX_BACKDROP_BYTES = 2048 * 1024 * 4; // a /backdrop capture, raw RGBA
// Assets go up as the car's do: one after another at about 5.6 MB a second (car log Nov 13 2026: 4 MiB textures 0.75 s
// apart). Until an asset's bytes are up, the effect layers sampling it are "waiting" with cluster-render's reason, and
// not drawn. BENCH_UPLOAD_KBPS sets the rate (0: at once).
const UPLOAD_BYTES_PER_MS =
  process.env.BENCH_UPLOAD_KBPS === undefined ? 5600 : Math.max(0, Number(process.env.BENCH_UPLOAD_KBPS) || 0);
const NOT_WRITTEN = "an asset it samples is not written yet"; // cluster-render's reason (compositor.cpp)
let uploadFreeAt = 0; // when the last queued asset is up
const MAX_CLIP_FRAME = 9999,
  CLIP_FRAME_DIGITS = 4; // a README GIF's frame numbers, 0000.png..9999.png
/**
 * The request's JSON body; {} when it does not parse.
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
function body(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > MAX_BODY_CHARS) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(text || "{}"));
      } catch (err) {
        resolve({});
      }
    });
  });
}

const web = http.createServer(async (req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") {
    res.writeHead(403);
    return res.end();
  }
  const url = req.url.split("?")[0];
  // the cluster backdrop's photos: BMW's own views warped to the panel's 1920x720 (stock-map.jpg, stock-sport.jpg, stock-nav.jpg, stock-acc.jpg), kept in
  // bench/.data/backdrops/ (not in git: car photos); without them the page draws its stand-in
  const backdrop = /^\/backdrop\/(stock-(?:map|sport|nav|acc))\.jpg$/.exec(url);
  if (req.method === "GET" && backdrop) {
    const file = path.join(
      __dirname,
      ".data",
      "backdrops",
      backdrop[1] + ".jpg",
    );
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": "image/jpeg",
      "cache-control": "no-store",
    });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === "GET" && url === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return fs.createReadStream(path.join(__dirname, "page.html")).pipe(res);
  }
  if (req.method === "GET" && url === "/px") {
    /** @type {Record<string, string>} */
    const query = {};
    (req.url.split("?")[1] || "").split("&").forEach((pair) => {
      const i = pair.indexOf("=");
      if (i > 0)
        query[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(
          pair.slice(i + 1),
        );
    });
    const pixels = pixelRect(query);
    if (!pixels) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    });
    return res.end(pixels);
  }
  if (req.method === "GET" && url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    send(helloMsg(), res);
    logLines.forEach((entry) => send(entry, res));
    send({ t: "scene", layers: sceneMeta(), pixels: pixelBytes() }, res);
    layers.forEach((layer) => sendPixels(layer, res));
    apps.forEach((app) => {
      if (app.lastSettings) send(app.lastSettings, res);
      if (app.lastStatus) send(app.lastStatus, res);
    });
    send(nav, res);
    send(assist, res); // the page draws BMW's guidance and ACC stand-ins from these
    send({ t: "car", values: carSw }, res);
    apps.forEach((app) =>
      send(
        { t: "app", app: app.id, state: app.child ? "running" : "stopped" },
        res,
      ),
    );
    return;
  }
  if (req.method === "POST" && url === "/signals") {
    const reqBody = await body(req);
    signals = {
      t: "signals",
      mode: reqBody.mode === "manual" ? "manual" : "demo",
      values: reqBody.values || {},
    };
    toApps(signals);
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/drive") {
    const reqBody = await body(req);
    drive = {
      t: "drive",
      value:
        reqBody.value === null || reqBody.value === undefined
          ? null
          : reqBody.value,
    };
    toApps(drive);
    log("info", "bench: drive mode " + JSON.stringify(drive.value));
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/nav") {
    const reqBody = await body(req);
    nav = {
      t: "nav",
      value: typeof reqBody.value === "string" ? reqBody.value : null,
    };
    toApps(nav);
    send(nav);
    log("info", "bench: route guidance " + JSON.stringify(nav.value));
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/car") {
    const reqBody = await body(req);
    if (typeof reqBody.key === "string" && /^[a-zA-Z]+$/.test(reqBody.key)) {
      if (typeof reqBody.value === "string" && reqBody.value)
        carSw[reqBody.key] = reqBody.value;
      else delete carSw[reqBody.key];
      toApps({ t: "car", key: reqBody.key, value: carSw[reqBody.key] || null });
      send({ t: "car", values: carSw });
      log(
        "info",
        "bench: " +
          reqBody.key +
          " " +
          JSON.stringify(carSw[reqBody.key] || null),
      );
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/assist") {
    const reqBody = await body(req);
    assist = {
      t: "assist",
      value:
        reqBody.value === "acc" || reqBody.value === "off"
          ? reqBody.value
          : null,
    };
    toApps(assist);
    send(assist);
    log("info", "bench: driver assistance " + JSON.stringify(assist.value));
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/restart") {
    const reqBody = await body(req),
      app = appOf(reqBody.app);
    if (app) restartApp(app, "restart button");
    else restartAll("restart button");
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/backdrop") {
    // bake mode (CLUSTER_BACKDROP_BAKE=1, launch config "bench-backdrop"): the page posts the cluster's display as raw
    // RGBA (straight alpha: see-through where nothing is drawn, as Sport's map window); the app's
    // <data>/backdrop-bake.json names it ("file": <layout>-<units>[-map]) and gives its key; written as ETC2 to
    // apps/<app>/hud/backdrops/<file>.etc2 with its .json (engine/backdrop.js)
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BACKDROP_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const app = apps.filter((a) => fs.existsSync(path.join(a.data, "backdrop-bake.json")))[0];
        if (!app) throw new Error("no app in backdrop bake mode (start the bench with CLUSTER_BACKDROP_BAKE=1)");
        const bake = JSON.parse(fs.readFileSync(path.join(app.data, "backdrop-bake.json"), "utf8"));
        const rgba = Buffer.concat(chunks);
        if (rgba.length !== bake.w * bake.h * 4)
          throw new Error(rgba.length + " bytes is not " + bake.w + "x" + bake.h + " RGBA");
        const dir = path.join(app.dir, "hud", "backdrops"),
          base = path.join(dir, bake.file || bake.layout + "-" + bake.units);
        fs.mkdirSync(dir, { recursive: true });
        const start = Date.now();
        const out = etc2.encode(rgba, bake.w, bake.h);
        fs.writeFileSync(base + ".etc2", out);
        fs.writeFileSync(
          base + ".json",
          JSON.stringify({ w: bake.w, h: bake.h, units: bake.units, key: bake.key }, null, 2) + "\n",
        );
        log(
          "info",
          "backdrop written: " + path.relative(ROOT, base) + ".etc2 (" + bake.w + "x" + bake.h + ", " + out.length +
            " bytes, key " + bake.key + ", " + ((Date.now() - start) / 1000).toFixed(1) + " s)",
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ file: path.relative(ROOT, base) + ".etc2", key: bake.key, bytes: out.length }));
      } catch (err) {
        res.writeHead(400);
        res.end(String(err instanceof Error ? err.message : err));
      }
    });
    return;
  }
  if (req.method === "POST" && url === "/shot") {
    // a README screenshot: the page posts a canvas as a PNG data URL; written to docs/images/<name>.png (name: letters,
    // digits, - and _ only)
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > MAX_SHOT_CHARS) req.destroy();
    });
    req.on("end", () => {
      try {
        const reqBody = JSON.parse(text),
          name = String(reqBody.name || "");
        const match = /^data:image\/png;base64,(.+)$/.exec(
          String(reqBody.data || ""),
        );
        if (!/^[a-z0-9_-]{1,40}$/i.test(name) || !match) {
          res.writeHead(400);
          return res.end("bad name or data");
        }
        // with "frame": one frame of a README GIF, written to bench/.data/clips/<name>/<frame>.png
        // (tools/clip_gif.sh turns the folder into docs/images/<name>.gif)
        if (reqBody.frame !== undefined) {
          const frame = Number(reqBody.frame);
          if (!Number.isInteger(frame) || frame < 0 || frame > MAX_CLIP_FRAME) {
            res.writeHead(400);
            return res.end("bad frame");
          }
          const dir = path.join(__dirname, ".data", "clips", name);
          if (frame === 0) fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(
              dir,
              String(frame).padStart(CLIP_FRAME_DIGITS, "0") + ".png",
            ),
            Buffer.from(match[1], "base64"),
          );
          res.writeHead(204);
          return res.end();
        }
        const out = path.join(ROOT, "docs", "images", name + ".png");
        fs.writeFileSync(out, Buffer.from(match[1], "base64"));
        log("info", "screenshot written: " + path.relative(ROOT, out));
        res.writeHead(204);
        res.end();
      } catch (err) {
        res.writeHead(400);
        res.end(String(err.message || err));
      }
    });
    return;
  }
  if (req.method === "POST" && url === "/cap") {
    // The layer cap, set live from the page. The app restarts so it registers its layers again under the new cap.
    const reqBody = await body(req);
    const cap = Math.max(0, Math.floor(Number(reqBody.cap) || 0));
    if (cap !== layerCap) {
      layerCap = cap;
      send(helloMsg());
      restartAll(
        "layer cap set to " +
          (cap || "unlimited") +
          ", the apps register their layers again",
      );
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/setting") {
    // Pressed on the stub's RHMI components, as the car's settings page sends it (run-app.js).
    const reqBody = await body(req),
      app = appOf(reqBody.app) || apps[0];
    if (!app.child) {
      res.writeHead(409);
      return res.end("app not running");
    }
    app.child.send({ t: "set", key: reqBody.key, value: reqBody.value });
    log(
      "info",
      "bench: " +
        app.id +
        " setting " +
        reqBody.key +
        " = " +
        JSON.stringify(reqBody.value),
    );
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(404);
  res.end();
});

try {
  fs.unlinkSync(SOCK);
} catch (err) {
  /* not there */
}
renderServer.listen(SOCK, () => {
  web.listen(PORT, "127.0.0.1", () => {
    log("info", "bench renderer on " + SOCK);
    log("info", "open http://localhost:" + PORT);
    if (layerCap)
      log(
        "info",
        "layer cap " +
          layerCap +
          " (BENCH_LAYER_CAP): layers past it get state waiting and are not drawn",
      );
    log(
      "info",
      "the service's limits: " +
        LAYERS_PER_CLIENT +
        " layers a connection, " +
        TOTAL_LAYERS +
        " across every connection, pixel memory " +
        (PIXEL_BYTES ? mib(PIXEL_BYTES) : "unlimited") +
        " (every image counted twice)",
    );
    apps.forEach(startApp);
  });
});
/** Stops the apps, removes the socket and exits. */
function shutdown() {
  apps.forEach((app) => {
    app.stopping = true;
    if (app.child) app.child.kill("SIGTERM");
  });
  try {
    fs.unlinkSync(SOCK);
  } catch (err) {
    /* gone */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
