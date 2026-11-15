"use strict";
/**
 * A client of live2d-render (idrive-apps-lib's native/live2d-render, README.md "Protocol"): its Unix socket, one flat
 * JSON object a line each way. Connects, and again every RETRY_MS while it can't (the service not installed or not
 * started yet); each connect emits "connect", where the widget sends its open. Every message from the service is
 * emitted by its "t" ("opened", "error", "layer", "stats", "unknown"). Node 8.
 */
const net = require("net");
const { EventEmitter } = require("events");

const SOCKET = "/dev/shm/live2d-render/render.sock";
const RETRY_MS = 3000;

class Live2dClient extends EventEmitter {
  /**
   * @param {string} [socketPath]
   */
  constructor(socketPath) {
    super();
    this.path = socketPath || SOCKET;
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
    const sock = net.connect(this.path);
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

module.exports = { Live2dClient, SOCKET };
