#!/usr/bin/env node
"use strict";
/**
 * Records a Live2D model's parameters from VTube Studio (motion capture through its face tracking), to bake into
 * animation frames.
 *
 *   node tools/live2d_bake/vts_record.js [--out clip.json] [--fps 30] [--host 192.168.1.20[:8001]]
 *
 * It asks for VTube Studio's address (Enter: this computer), connects to its plugin API (VTube Studio: Settings, "Start
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
 * Needs Node 22 or newer (its built-in WebSocket); runs on your computer, never on the car.
 */
const fs = require("fs");
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

const fps = Math.min(MAX_FPS, Math.max(1, Number(arg("fps", String(DEFAULT_FPS))) || DEFAULT_FPS));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const outFile = path.resolve(arg("out", "vts-" + stamp + ".json") || "");

// Node 22's WebSocket warns that it is experimental on first use; it works, so that one warning is dropped
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (/** @type {{ code?: string }} */ (warning).code !== "UNDICI-WS") console.warn(warning.name + ": " + warning.message);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
/** @param {string} question @returns {Promise<string>} */
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

/**
 * One connection to VTube Studio's API: requests answered by their requestID.
 * @param {string} url
 */
function connect(url) {
  if (typeof WebSocket !== "function") throw new Error("this Node has no WebSocket: use Node 22 or newer");
  const ws = new WebSocket(url);
  /** @type {Map<string, { resolve: (msg: *) => void, reject: (err: Error) => void, timer: NodeJS.Timeout }>} */
  const waiting = new Map();
  let next = 0;
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
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
  });
  ws.addEventListener("close", () => {
    waiting.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(new Error("VTube Studio closed the connection"));
    });
    waiting.clear();
  });
  return {
    ws,
    /** @returns {Promise<void>} */
    open: () =>
      new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener(
          "error",
          () => reject(new Error("can't reach VTube Studio at " + url + " (is its API started, and the address right?)")),
          { once: true },
        );
      }),
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
        waiting.set(requestID, { resolve, reject, timer });
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
  let host = arg("host") || (await ask("VTube Studio's address (Enter: this computer): ")).trim() || "127.0.0.1";
  if (!/:\d+$/.test(host)) host += ":" + DEFAULT_PORT;
  const api = connect("ws://" + host);
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
      console.error("\n" + (err instanceof Error ? err.message : err));
    }
    busy = false;
  }, 1000 / fps);
  const progress = setInterval(() => {
    process.stdout.write("\rrecording " + ((Date.now() - t0) / 1000).toFixed(0) + " s, " + frames.length + " frames   (Enter: save, Ctrl+C: quit)");
  }, PROGRESS_MS);

  await ask("recording, Enter to save\n");
  clearInterval(poll);
  clearInterval(progress);
  const clip = { source: "VTube Studio", model: { name: first.modelName, id: first.modelID }, fps, params, names, frames };
  fs.writeFileSync(outFile, JSON.stringify(clip));
  const secs = frames.length ? frames[frames.length - 1].t / 1000 : 0;
  console.log(
    "\nwrote " + outFile + ": " + frames.length + " frames over " + secs.toFixed(1) + " s" +
      (late ? " (" + late + " ticks skipped while VTube Studio was slow)" : ""),
  );
  api.ws.close();
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
