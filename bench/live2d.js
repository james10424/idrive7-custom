"use strict";
/**
 * The bench's live2d-render, for the Miku Live2D layout: the real program (native/live2d-render/prebuilt, the one
 * the Store installs) and its Cubism glue (native/live2d-render/build/sdk, `make glue`) in Docker, drawing on Mesa's
 * software renderer. Docker on the Mac can't share Unix sockets, so socat in the container carries both over TCP:
 * the app reaches live2d-render at HUD_LIVE2D_SOCKET ("127.0.0.1:<port>"), and live2d-render reaches the bench's
 * fake cluster-render on its TCP port (host.docker.internal), where its video layer is drawn like any other.
 *
 * Once, the model, as on the car its textures shrunk to 1024 px:
 *
 *   node bench/live2d.js <model>.model3.json      to bench/.data/live2d-models/<model>/
 *
 * The bench starts it by itself when the glue is built, the model is there and Docker runs (else it logs why not,
 * and Miku Live2D says live2d-render isn't running), and the page's Live2D Render button starts it (again) any time:
 * after Docker is started, or when it is stuck.
 */
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "native", "live2d-render");
const MODELS = path.join(__dirname, ".data", "live2d-models");
const PORT_IN = 7655; // live2d-render's socket, through socat, inside the container

/**
 * Why the bench can't run live2d-render now ("" when it can).
 * @returns {string}
 */
function whyNot() {
  if (!fs.existsSync(path.join(DIR, "prebuilt", "live2d-render"))) return "no native/live2d-render/prebuilt/live2d-render";
  if (!fs.existsSync(path.join(DIR, "build", "sdk", "liblive2d-glue.so")))
    return "no Cubism glue (cd native/live2d-render && make glue SDK=<Cubism SDK for Native>)";
  const models = fs.existsSync(MODELS) ? fs.readdirSync(MODELS).filter((d) => !d.startsWith(".")) : [];
  if (!models.length) return "no model (node bench/live2d.js <model>.model3.json)";
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 10000 });
  if (docker.status !== 0) return "Docker isn't running";
  return "";
}

/**
 * The bench's live2d-render: one container, on a host port fixed for the bench's life (the app is given it once,
 * HUD_LIVE2D_SOCKET, before it starts), so it can be started later (Docker not running when the bench started) or
 * restarted (stuck) and the app finds it again by itself (it retries every 3 s).
 * @param {number} renderPort the bench's fake cluster-render, on TCP
 * @param {number} hostPort the Mac's loopback port live2d-render's socket is published on
 * @param {(level: string, text: string) => void} log
 */
function controller(renderPort, hostPort, log) {
  const name = "hud-bench-live2d-" + process.pid;
  const addr = "127.0.0.1:" + hostPort;
  /** @type {?import("child_process").ChildProcess} */
  let logs = null;
  let gpu = ""; // its last "GPU memory" line (at an open): "71.2 MiB (textures 68.0, ...)"
  let paused = false;
  /** @returns {string} "running", "paused", "exited", ... or "stopped" when there is no container */
  const status = () => {
    const r = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", name], { encoding: "utf8", timeout: 10000 });
    return r.status === 0 ? r.stdout.trim() : "stopped";
  };
  const follow = () => {
    if (logs) logs.kill();
    logs = spawn("docker", ["logs", "-f", "--since", "1s", name], { stdio: ["ignore", "pipe", "pipe"] });
    /** @param {Buffer} chunk */
    const lines = (chunk) =>
      String(chunk)
        .split("\n")
        .filter((l) => l.trim() && !/^libEGL warning/.test(l))
        .forEach((l) => {
          const m = /GPU memory (.*)$/.exec(l);
          if (m) gpu = m[1];
          log("info", "live2d-render: " + l.replace(/^live2d-render: /, ""));
        });
    if (logs.stdout) logs.stdout.on("data", lines);
    if (logs.stderr) logs.stderr.on("data", lines);
  };
  const remove = () => {
    if (logs) logs.kill();
    logs = null;
    spawnSync("docker", ["rm", "-f", name], { timeout: 15000 });
    paused = false;
  };
  return {
    addr,
    /**
     * Its state for the page: running, paused, stopped (and why it can't run, when it can't).
     * @returns {{ state: string, why: string, gpu: string }}
     */
    state() {
      const why = whyNot();
      return { state: why === "Docker isn't running" ? "stopped" : status(), why, gpu };
    },
    /**
     * Starts it, or starts it afresh (a container already there goes first: a stuck one is a fresh process).
     * @returns {boolean} whether it runs now
     */
    start() {
      const why = whyNot();
      if (why) {
        log("info", "live2d-render: not on this bench (" + why + "); Miku Live2D says it isn't installed");
        return false;
      }
      const image = spawnSync("make", ["-s", "-C", DIR, "image"], { encoding: "utf8" });
      if (image.status !== 0) {
        log("warn", "live2d-render: its Docker image didn't build: " + (image.stderr || "").trim());
        return false;
      }
      remove();
      const script = [
        "socat UNIX-LISTEN:/tmp/cr.sock,fork TCP:host.docker.internal:" + renderPort + " &",
        "socat TCP-LISTEN:" + PORT_IN + ",fork,reuseaddr UNIX-CONNECT:/tmp/l2r.sock &",
        "exec /lib64/ld-linux-x86-64.so.2 /w/prebuilt/live2d-render --software --socket /tmp/l2r.sock " +
          "--cluster-socket /tmp/cr.sock --sdk /w/build/sdk --state /tmp/state --idle-exit 0",
      ].join("\n");
      const run = spawnSync(
        "docker",
        ["run", "-d", "--name", name, "--platform", "linux/amd64", "-p", addr + ":" + PORT_IN,
          "-v", DIR + ":/w:ro", "-v", MODELS + ":/var/opt/live2d-render/models:ro", image.stdout.trim(), "sh", "-c", script],
        { encoding: "utf8" },
      );
      if (run.status !== 0) {
        log("warn", "live2d-render: docker run failed: " + (run.stderr || "").trim());
        return false;
      }
      follow();
      log("info", "live2d-render: started in Docker (" + name + ", Mesa's software renderer) at " + addr + ", models from " + MODELS);
      return true;
    },
    /**
     * Frozen (docker pause: no CPU at all) or running again; the page's redraw switch.
     * @param {boolean} on
     */
    pause(on) {
      if (on === paused || status() !== (on ? "running" : "paused")) return;
      paused = on;
      const r = spawnSync("docker", [on ? "pause" : "unpause", name], { encoding: "utf8", timeout: 10000 });
      if (r.status !== 0) log("warn", "live2d-render: docker " + (on ? "pause" : "unpause") + " failed: " + (r.stderr || "").trim());
      else log("info", "live2d-render: " + (on ? "paused (redraw off)" : "running again"));
    },
    stop() {
      remove();
    },
  };
}

/**
 * The model into bench/.data/live2d-models/<name>/, its textures shrunk to 1024 px (as deploy.sh --miku-live does).
 * @param {string} model3 the .model3.json
 */
function setup(model3) {
  const src = path.dirname(path.resolve(model3)),
    base = path.basename(model3),
    name = base.replace(/\.model3\.json$/, ""),
    out = path.join(MODELS, name);
  const m = JSON.parse(fs.readFileSync(model3, "utf8"));
  const refs = m.FileReferences;
  fs.mkdirSync(out, { recursive: true });
  [refs.Moc].concat(refs.Physics ? [refs.Physics] : []).forEach((f) => {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(out, f));
  });
  (refs.Textures || []).forEach((/** @type {string} */ t) => {
    fs.mkdirSync(path.dirname(path.join(out, t)), { recursive: true });
    execFileSync("sips", ["-Z", "1024", path.join(src, t), "--out", path.join(out, t)], { stdio: "ignore" });
  });
  m.FileReferences = { Moc: refs.Moc, Textures: refs.Textures, Physics: refs.Physics };
  fs.writeFileSync(path.join(out, base), JSON.stringify(m, null, 1));
  console.log(out + ": the model, " + (refs.Textures || []).length + " textures at 1024 px; the bench mounts it at /var/opt/live2d-render/models/" + name);
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error("usage: node bench/live2d.js <model>.model3.json");
    process.exit(2);
  }
  setup(process.argv[2]);
}

module.exports = { controller, whyNot };
