#!/usr/bin/env node
"use strict";
/**
 * Records a Live2D model's parameters from VTube Studio (motion capture through its face tracking), to bake into
 * animation frames.
 *
 *   node tools/live2d_bake/vts_record.js [192.168.1.20[:8001]] [--out clip.json] [--fps 30]
 *
 * VTube Studio's address is the first argument (an IP or a name, :port if not 8001); without it, it asks (Enter: this
 * computer). It connects to its plugin API (VTube Studio: Settings, "Start
 * API", port 8001 by default; from another computer, that machine's IP), and the first time asks VTube Studio for a
 * token: click Allow in its popup. The token is kept in ~/.config/idrive7-custom/vts-token for next time. Then it
 * records the loaded model's parameters, polled --fps times a second (the API has no parameter-change event), until
 * you press Enter, and writes the clip. Ctrl+C quits without saving.
 *
 * The clip (JSON):
 *   { source: "VTube Studio", model: { name, id }, fps,
 *     params: { name: { min, max, default } },
 *     names: [the parameter names, in the order of each frame's values],
 *     frames: [{ t: ms from the start, v: [values] }] }
 *
 * VTube Studio's physics (hair, ribbons) is in the recorded values too: when baking, apply the face and body
 * parameters and let the model's own physics redo the rest, or the swing is applied twice.
 *
 * Plain Node (its own small WebSocket client, below: Node 22.1's built-in one drops the connection on the fragmented
 * messages VTube Studio sends past about 1 KB); runs on your computer, never on the car.
 */
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const readline = require("readline");

const DEFAULT_PORT = 8001;
const DEFAULT_FPS = 30;
const MAX_FPS = 60;
const PLUGIN = { pluginName: "Miku bake recorder", pluginDeveloper: "idrive7-custom" };
const TOKEN_FILE = path.join(os.homedir(), ".config", "idrive7-custom", "vts-token");
// how long to wait for VTube Studio's answer (the token popup waits on you, so longer)
const ANSWER_MS = 5000,
  TOKEN_MS = 120000;
const PROGRESS_MS = 1000; // the recording line updates this often

/**
 * The value after --name on the command line, else def.
 * @param {string} name
 * @param {string} [def]
 * @returns {string | undefined}
 */
function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/**
 * The first command-line argument that isn't a --flag or a flag's value: VTube Studio's address.
 * @returns {string | undefined}
 */
function positional() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) i++;
    else return args[i];
  }
  return undefined;
}

const fps = Math.min(MAX_FPS, Math.max(1, Number(arg("fps", String(DEFAULT_FPS))) || DEFAULT_FPS));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const outFile = path.resolve(arg("out", "vts-" + stamp + ".json") || "");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
/** @param {string} question @returns {Promise<string>} */
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

// WebSocket (RFC 6455) as far as VTube Studio needs: text messages, fragmented or not, ping, close
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONTINUATION = 0,
  OP_TEXT = 1,
  OP_CLOSE = 8,
  OP_PING = 9,
  OP_PONG = 10;
const FIN = 0x80,
  MASKED = 0x80,
  LEN_16 = 126,
  LEN_64 = 127,
  CLOSE_NORMAL = 1000,
  CLOSE_ABNORMAL = 1006,
  KEY_BYTES = 16,
  MASK_BYTES = 4;

/**
 * A WebSocket client on a plain socket.
 * @param {string} host
 * @param {number} port
 * @param {{ onOpen: () => void, onMessage: (text: string) => void, onClose: (code: number, reason: string) => void,
 *   onError: (err: Error) => void }} on
 */
function webSocket(host, port, on) {
  const key = crypto.randomBytes(KEY_BYTES).toString("base64");
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  const sock = net.connect(port, host);
  let open = false,
    closed = false,
    buf = Buffer.alloc(0);
  /** @type {Buffer[]} a fragmented message's parts so far */
  let parts = [];
  /** @param {number} code @param {string} reason @param {boolean} [polite] end the socket (after a close frame) */
  const finish = (code, reason, polite) => {
    if (closed) return;
    closed = true;
    if (polite) sock.end();
    else sock.destroy();
    if (open) on.onClose(code, reason);
  };
  /** @param {number} op @param {Buffer} payload */
  const frame = (op, payload) => {
    const mask = crypto.randomBytes(MASK_BYTES);
    let head;
    if (payload.length < LEN_16) head = Buffer.from([FIN | op, MASKED | payload.length]);
    else if (payload.length < 0x10000) {
      head = Buffer.alloc(4);
      head[0] = FIN | op;
      head[1] = MASKED | LEN_16;
      head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = FIN | op;
      head[1] = MASKED | LEN_64;
      head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i % MASK_BYTES];
    if (!closed) sock.write(Buffer.concat([head, mask, body]));
  };
  sock.on("connect", () =>
    sock.write(
      "GET / HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n",
    ),
  );
  sock.on("data", (data) => {
    buf = Buffer.concat([buf, data]);
    if (!open) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.slice(0, end).toString();
      buf = buf.slice(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head) || head.indexOf(accept) < 0) {
        closed = true;
        sock.destroy();
        return on.onError(new Error("not a WebSocket answer: " + head.split("\r\n")[0]));
      }
      open = true;
      on.onOpen();
    }
    // whole frames: FIN and opcode, then the length (7 bits, or 16 or 64 after it), the server's frames unmasked
    while (buf.length >= 2) {
      const fin = (buf[0] & FIN) !== 0,
        op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f,
        at = 2;
      if (len === LEN_16) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === LEN_64) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (buf[1] & MASKED) at += MASK_BYTES; // a server mustn't mask; skipped if it does
      if (buf.length < at + len) return;
      const payload = buf.slice(at, at + len);
      buf = buf.slice(at + len);
      if (op === OP_TEXT || op === OP_CONTINUATION) {
        parts.push(payload);
        if (fin) {
          const text = Buffer.concat(parts).toString("utf8");
          parts = [];
          on.onMessage(text);
        }
      } else if (op === OP_PING) frame(OP_PONG, payload);
      else if (op === OP_CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_NORMAL;
        frame(OP_CLOSE, payload.slice(0, 2));
        finish(code, payload.slice(2).toString("utf8"), true);
      }
    }
  });
  sock.on("error", (err) => {
    if (open) finish(CLOSE_ABNORMAL, err.message);
    else if (!closed) {
      closed = true;
      on.onError(err);
    }
  });
  sock.on("close", () => finish(CLOSE_ABNORMAL, ""));
  return {
    /** @param {string} text */
    send: (text) => frame(OP_TEXT, Buffer.from(text, "utf8")),
    close: () => {
      frame(OP_CLOSE, Buffer.from([CLOSE_NORMAL >> 8, CLOSE_NORMAL & 0xff]));
      finish(CLOSE_NORMAL, "", true);
    },
  };
}

/**
 * One connection to VTube Studio's API: requests answered by their requestID.
 * @param {string} host
 * @param {number} port
 */
function connect(host, port) {
  /** @type {Map<string, { type: string, resolve: (msg: *) => void, reject: (err: Error) => void, timer: NodeJS.Timeout }>} */
  const waiting = new Map();
  let next = 0;
  /** @type {(err?: Error) => void} */
  let opened = () => {};
  const ws = webSocket(host, port, {
    onOpen: () => opened(),
    onError: (err) =>
      opened(new Error("can't reach VTube Studio at " + host + ":" + port + " (" + err.message + "; is its API started, and the address right?)")),
    onMessage: (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        return;
      }
      const entry = waiting.get(msg.requestID);
      if (!entry) return;
      waiting.delete(msg.requestID);
      clearTimeout(entry.timer);
      if (msg.messageType === "APIError")
        entry.reject(new Error("VTube Studio: " + (msg.data && msg.data.message) + " (error " + (msg.data && msg.data.errorID) + ")"));
      else entry.resolve(msg.data || {});
    },
    onClose: (code, reason) => {
      // the close code and VTube Studio's reason, if it gave one (1000 normal, 1006 dropped without a close frame)
      const why = "VTube Studio closed the connection (code " + code + (reason ? ": " + reason : "") + ")";
      waiting.forEach((entry, requestID) => {
        clearTimeout(entry.timer);
        entry.reject(new Error(why + " while waiting for " + entry.type + " " + requestID));
      });
      if (!waiting.size && code !== CLOSE_NORMAL) console.error("\n" + why);
      waiting.clear();
    },
  });
  return {
    close: ws.close,
    /** @returns {Promise<void>} */
    open: () => new Promise((resolve, reject) => (opened = (err) => (err ? reject(err) : resolve()))),
    /**
     * @param {string} type messageType
     * @param {object} [data]
     * @param {number} [ms] how long to wait for the answer
     * @returns {Promise<*>} the answer's data
     */
    request: (type, data, ms) =>
      new Promise((resolve, reject) => {
        const requestID = "r" + next++;
        const timer = setTimeout(() => {
          waiting.delete(requestID);
          reject(new Error("VTube Studio didn't answer " + type));
        }, ms || ANSWER_MS);
        waiting.set(requestID, { type, resolve, reject, timer });
        ws.send(JSON.stringify({ apiName: "VTubeStudioPublicAPI", apiVersion: "1.0", requestID, messageType: type, data: data || {} }));
      }),
  };
}

/**
 * Authenticates with the kept token, or asks VTube Studio for a new one (its Allow popup).
 * @param {ReturnType<typeof connect>} api
 */
async function authenticate(api) {
  let token = "";
  try {
    token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch (err) {
    /* first time */
  }
  if (token) {
    const auth = await api.request("AuthenticationRequest", Object.assign({ authenticationToken: token }, PLUGIN));
    if (auth.authenticated) return;
    console.log("the kept token was refused (" + auth.reason + "), asking for a new one");
  }
  console.log("click Allow in VTube Studio's popup");
  const answer = await api.request("AuthenticationTokenRequest", PLUGIN, TOKEN_MS);
  token = answer.authenticationToken;
  const auth = await api.request("AuthenticationRequest", Object.assign({ authenticationToken: token }, PLUGIN));
  if (!auth.authenticated) throw new Error("VTube Studio refused the plugin: " + auth.reason);
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

async function main() {
  let host = positional() || arg("host") || (await ask("VTube Studio's address (Enter: this computer): ")).trim() || "127.0.0.1";
  const portMatch = /:(\d+)$/.exec(host);
  const api = connect(portMatch ? host.slice(0, portMatch.index) : host, portMatch ? Number(portMatch[1]) : DEFAULT_PORT);
  await api.open();
  await authenticate(api);

  const first = await api.request("Live2DParameterListRequest");
  if (!first.modelLoaded) throw new Error("no model loaded in VTube Studio");
  /** @type {string[]} */
  const names = first.parameters.map((/** @type {{ name: string }} */ p) => p.name);
  /** @type {Record<string, { min: number, max: number, default: number }>} */
  const params = {};
  first.parameters.forEach((/** @type {{ name: string, min: number, max: number, defaultValue: number }} */ p) => {
    params[p.name] = { min: p.min, max: p.max, default: p.defaultValue };
  });
  console.log(first.modelName + ": " + names.length + " parameters");

  /** @type {Array<{ t: number, v: number[] }>} */
  const frames = [];
  const t0 = Date.now();
  let busy = false,
    stopped = false,
    late = 0;
  const poll = setInterval(async () => {
    // one request at a time: a slow answer skips a tick instead of piling up
    if (busy) return void late++;
    busy = true;
    try {
      const list = await api.request("Live2DParameterListRequest");
      /** @type {Record<string, number>} */
      const byName = {};
      list.parameters.forEach((/** @type {{ name: string, value: number }} */ p) => (byName[p.name] = p.value));
      frames.push({ t: Date.now() - t0, v: names.map((name) => (name in byName ? byName[name] : params[name].default)) });
    } catch (err) {
      if (!stopped) console.error("\n" + (err instanceof Error ? err.message : err));
    }
    busy = false;
  }, 1000 / fps);
  const progress = setInterval(() => {
    process.stdout.write("\rrecording " + ((Date.now() - t0) / 1000).toFixed(0) + " s, " + frames.length + " frames   (Enter: save, Ctrl+C: quit)");
  }, PROGRESS_MS);

  await ask("recording, Enter to save\n");
  stopped = true;
  clearInterval(poll);
  clearInterval(progress);
  const clip = { source: "VTube Studio", model: { name: first.modelName, id: first.modelID }, fps, params, names, frames };
  fs.writeFileSync(outFile, JSON.stringify(clip));
  const secs = frames.length ? frames[frames.length - 1].t / 1000 : 0;
  console.log(
    "\nwrote " + outFile + ": " + frames.length + " frames over " + secs.toFixed(1) + " s" +
      (late ? " (" + late + " ticks skipped while VTube Studio was slow)" : ""),
  );
  api.close();
  rl.close();
}

rl.on("SIGINT", () => {
  console.log("\nquit, nothing saved");
  process.exit(130);
});
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
