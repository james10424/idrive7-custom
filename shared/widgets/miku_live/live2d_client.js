"use strict";
/**
 * A client of live2d-render (native/live2d-render, its README.md "Protocol"): its Unix socket, one flat
 * JSON object a line each way. Connects, and again every RETRY_MS while it can't (the service not installed or not
 * started yet); each connect emits "connect", where the widget sends its open. Every message from the service is
 * emitted by its "t" ("opened", "error", "layer", "stats", "unknown"). Node 8.
 */
const net = require("net");
const { EventEmitter } = require("events");

const SOCKET = "/dev/shm/live2d-render/render.sock";
const RETRY_MS = 3000;
const RESTART_WAIT_MS = 3000; // restartService: live2d-render's answer waited for this long

class Live2dClient extends EventEmitter {
  /**
   * @param {string} [socketPath]
   */
  constructor(socketPath) {
    super();
    // HUD_LIVE2D_SOCKET: the Mac bench's live2d-render in Docker ("host:port"); never set on the car
    this.path = socketPath || process.env.HUD_LIVE2D_SOCKET || SOCKET;
    /** @type {?net.Socket} */
    this.sock = null;
    this.connected = false;
    this.closed = false;
    this.buf = "";
    /** @type {?ReturnType<typeof setTimeout>} */
    this.retryT = null;
    /** why the last connect failed ("" while connected or not tried) */
    this.why = "";
    this._connect();
  }

  /** @returns {void} */
  _connect() {
    if (this.closed) return;
    const tcp = /^([\w.-]+):(\d+)$/.exec(this.path);
    const sock = tcp ? net.connect(Number(tcp[2]), tcp[1]) : net.connect(this.path);
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      this.connected = true;
      this.why = "";
      this.emit("connect");
    });
    sock.on("data", (/** @type {string} */ chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          continue;
        }
        if (msg && typeof msg.t === "string") this.emit(msg.t, msg);
      }
    });
    sock.on("error", (/** @type {NodeJS.ErrnoException} */ err) => {
      this.why = err.code === "ENOENT" ? "live2d-render isn't installed" : err.code === "ECONNREFUSED" ? "live2d-render isn't running" : err.message;
    });
    sock.on("close", () => {
      const was = this.connected;
      this.connected = false;
      this.sock = null;
      this.buf = "";
      if (was) this.emit("disconnect");
      if (!this.closed) this.retryT = setTimeout(() => this._connect(), RETRY_MS);
    });
  }

  /**
   * Sends one message (dropped while not connected: the next connect sends the open again).
   * @param {Record<string, string | number | boolean>} msg
   * @returns {boolean}
   */
  send(msg) {
    if (!this.connected || !this.sock) return false;
    this.sock.write(JSON.stringify(msg) + "\n");
    return true;
  }

  /** Disconnects for good (the model goes with the connection). */
  close() {
    this.closed = true;
    if (this.retryT) clearTimeout(this.retryT);
    if (this.sock) this.sock.destroy();
    this.sock = null;
    this.connected = false;
  }
}

/**
 * Asks live2d-render to clear its crash guard (the drawing file and the crash count) and restart, over a connection
 * of its own (live2d-render serves one app at a time: the widget's model goes with it, and the widget's client
 * reconnects and opens her again once systemd has started live2d-render anew). Resolves with what happened.
 * @param {string} [socketPath]
 * @returns {Promise<string>}
 */
function restartService(socketPath) {
  return new Promise((resolve) => {
    const path = socketPath || process.env.HUD_LIVE2D_SOCKET || SOCKET;
    const tcp = /^([\w.-]+):(\d+)$/.exec(path);
    const sock = tcp ? net.connect(Number(tcp[2]), tcp[1]) : net.connect(path);
    let buf = "",
      done = false;
    const finish = (/** @type {string} */ why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(why);
    };
    const timer = setTimeout(() => finish("live2d-render didn't answer"), RESTART_WAIT_MS);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ t: "restart" }) + "\n"));
    sock.on("data", (/** @type {string} */ chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        /** @type {*} */
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          continue;
        }
        if (msg && msg.t === "restarting") finish("restarting, crash guard cleared");
        else if (msg && msg.t === "error") finish("live2d-render refused: " + msg.reason + " (restart needs Live2D Render 0.1.9 or later)");
      }
    });
    // it exits right after its answer
    sock.on("close", () => finish("restarting"));
    sock.on("error", (/** @type {NodeJS.ErrnoException} */ err) =>
      finish(err.code === "ENOENT" ? "live2d-render isn't installed" : err.message),
    );
  });
}

module.exports = { Live2dClient, SOCKET, restartService };
