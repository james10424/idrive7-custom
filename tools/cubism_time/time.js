"use strict";
/**
 * How long Cubism Core takes to pose a Live2D model on this machine: model.update() a frame, plus reading every
 * drawable's vertices back (what a mesh-layer Live2D would send to the KOMBI each frame). Run on the car by
 * tools/cubism_time/run.sh, or by hand anywhere:
 *
 *   node time.js <live2dcubismcore.js> <model.moc3> [frames=300]
 *
 * Plain Node 8 (the car's 8.16.2): no optional chaining, no ??, no dependencies. Prints one report; changes nothing.
 * The pose moves every frame (head and body turns, blinks, breath) so the deformers do real work.
 */
const fs = require("fs");
const os = require("os");
const vm = require("vm");

const WARMUP = 20;

/**
 * Cubism Core's script as a value: it declares a global var, so it runs in this context and hands it back.
 * @param {string} file
 * @returns {*}
 */
function loadCore(file) {
  const src = fs.readFileSync(file, "utf8");
  const wrap = vm.runInThisContext(
    "(function (require, __dirname, module, exports) {" +
      src +
      "\n;return Live2DCubismCore;})",
    { filename: file },
  );
  return wrap(require, __dirname, {}, {});
}

/**
 * Milliseconds since start, from a process.hrtime() pair.
 * @param {[number, number]} start
 * @returns {number}
 */
function msSince(start) {
  const d = process.hrtime(start);
  return d[0] * 1000 + d[1] / 1e6;
}

/**
 * @param {number[]} sorted ascending
 * @param {number} q 0..1
 * @returns {number}
 */
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * "mean 1.23, p50 1.20, p95 1.80, max 3.10 ms"
 * @param {number[]} times
 * @returns {string}
 */
function summary(times) {
  const sorted = times.slice().sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return (
    "mean " +
    mean.toFixed(2) +
    ", p50 " +
    quantile(sorted, 0.5).toFixed(2) +
    ", p95 " +
    quantile(sorted, 0.95).toFixed(2) +
    ", max " +
    sorted[sorted.length - 1].toFixed(2) +
    " ms"
  );
}

/**
 * Waits until Core's WebAssembly is ready (it starts asynchronously), then runs ready(); gives up after 15 s.
 * @param {*} core
 * @param {Buffer} moc
 * @param {(model: *) => void} ready
 * @returns {void}
 */
function whenReady(core, moc, ready) {
  const started = Date.now();
  const attempt = () => {
    let model = null;
    try {
      const bytes = moc.buffer.slice(
        moc.byteOffset,
        moc.byteOffset + moc.length,
      );
      const parsed = core.Moc.fromArrayBuffer(bytes);
      model = parsed ? core.Model.fromMoc(parsed) : null;
    } catch (err) {
      model = null;
    }
    if (model) return ready(model);
    if (Date.now() - started > 15000) {
      console.log("Cubism Core never became ready (15 s)");
      process.exit(1);
    }
    setTimeout(attempt, 50);
  };
  attempt();
}

/**
 * The parameters a frame moves, by id (those the model lacks are skipped), as functions of the frame number.
 * @type {Record<string, (frame: number) => number>}
 */
const POSE = {
  ParamAngleX: (k) => 30 * Math.sin(k * 0.05),
  ParamAngleY: (k) => 15 * Math.sin(k * 0.037),
  ParamAngleZ: (k) => 10 * Math.sin(k * 0.029),
  ParamBodyAngleX: (k) => 8 * Math.sin(k * 0.03),
  ParamEyeBallX: (k) => Math.sin(k * 0.07),
  ParamEyeLOpen: (k) => (k % 60 < 5 ? 0 : 1),
  ParamEyeROpen: (k) => (k % 60 < 5 ? 0 : 1),
  ParamBreath: (k) => 0.5 + 0.5 * Math.sin(k * 0.1),
};

function main() {
  const corePath = process.argv[2],
    mocPath = process.argv[3],
    frames = +process.argv[4] || 300;
  if (!corePath || !mocPath) {
    console.log(
      "usage: node time.js <live2dcubismcore.js> <model.moc3> [frames]",
    );
    process.exit(2);
  }
  const cpus = os.cpus();
  console.log(
    "node " +
      process.version +
      ", " +
      cpus.length +
      " x " +
      (cpus[0] ? cpus[0].model.trim() : "?") +
      ", load " +
      os
        .loadavg()
        .map((v) => v.toFixed(2))
        .join(" "),
  );
  const loadStart = process.hrtime();
  const core = loadCore(corePath);
  const moc = fs.readFileSync(mocPath);
  whenReady(core, moc, (model) => {
    console.log(
      "Core loaded and the model made in " + msSince(loadStart).toFixed(0) + " ms",
    );
    const params = model.parameters,
      drawables = model.drawables;
    /** @type {{ index: number, pose: (frame: number) => number }[]} */
    const moving = [];
    Object.keys(POSE).forEach((id) => {
      const index = params.ids.indexOf(id);
      if (index >= 0) moving.push({ index: index, pose: POSE[id] });
    });
    let vertices = 0;
    for (let i = 0; i < drawables.count; i++)
      vertices += drawables.vertexCounts[i];
    console.log(
      drawables.count +
        " drawables, " +
        vertices +
        " vertices, " +
        params.count +
        " parameters (" +
        moving.length +
        " moved a frame)",
    );
    const out = new Float32Array(vertices * 2);
    /** @type {number[]} */
    const updateMs = [];
    /** @type {number[]} */
    const readMs = [];
    for (let k = 0; k < WARMUP + frames; k++) {
      for (let j = 0; j < moving.length; j++)
        params.values[moving[j].index] = moving[j].pose(k);
      const t0 = process.hrtime();
      model.update();
      const update = msSince(t0);
      const t1 = process.hrtime();
      let at = 0;
      for (let i = 0; i < drawables.count; i++) {
        out.set(drawables.vertexPositions[i], at);
        at += drawables.vertexPositions[i].length;
      }
      const read = msSince(t1);
      if (k >= WARMUP) {
        updateMs.push(update);
        readMs.push(read);
      }
    }
    console.log("update:  " + summary(updateMs));
    console.log("vertices read back: " + summary(readMs));
    console.log(
      "all vertices a frame: " +
        ((vertices * 8) / 1024).toFixed(0) +
        " KB, " +
        ((vertices * 8 * 30) / 1048576).toFixed(2) +
        " MB/s at 30 fps",
    );
    console.log(
      frames +
        " frames; a 30 fps tick is 33.3 ms for everything the app does",
    );
  });
}

main();
