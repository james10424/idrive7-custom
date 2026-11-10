"use strict";
/* The bench's build lock: every bench running on this repo builds an app into the same dist/<id>/ (two benches,
 * e.g. "bench" and "bench-hud", both rebuild an app when one of its files is saved), so a build holds this lock and
 * other benches wait for it. */
const fs = require("fs");
const path = require("path");

/* The build lock: a folder dist/.build-<id>.lock (mkdir is atomic) holding the owner's pid. Waits for another bench's
 * build to end, up to BUILD_LOCK_WAIT_MS; a lock whose owner is gone, or older than BUILD_LOCK_STALE_MS, is taken over.
 * log(level, text) reports waiting and take-overs. Returns the release function, or null when it gave up. */
const BUILD_LOCK_WAIT_MS = 120000;
const BUILD_LOCK_STALE_MS = 300000;
/**
 * @param {string} distDir
 * @param {string} id the app id
 * @param {(level: "info" | "warn", text: string) => void} log
 * @returns {(() => void) | null} the release function
 */
function takeBuildLock(distDir, id, log) {
  const dir = path.join(distDir, ".build-" + id + ".lock");
  const pidFile = path.join(dir, "pid");
  fs.mkdirSync(distDir, { recursive: true });
  const until = Date.now() + BUILD_LOCK_WAIT_MS;
  let waited = false;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(pidFile, String(process.pid));
      if (waited)
        log("info", "build " + id + ": the other bench finished, building");
      return () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          /* gone */
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    // held: by a live bench, recently? then wait; else take it over
    let owner = 0,
      age = 0;
    try {
      owner = Number(fs.readFileSync(pidFile, "utf8"));
    } catch (err) {
      /* being written or gone */
    }
    try {
      age = Date.now() - fs.statSync(dir).mtimeMs;
    } catch (err) {
      continue;
    }
    let alive = false;
    if (owner > 0) {
      try {
        process.kill(owner, 0);
        alive = true;
      } catch (err) {
        alive = err.code === "EPERM";
      }
    }
    if ((owner > 0 && !alive) || age > BUILD_LOCK_STALE_MS) {
      log(
        "warn",
        "build " +
          id +
          ": taking over a stale build lock" +
          (owner ? " (pid " + owner + ")" : ""),
      );
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        /* someone else did */
      }
      continue;
    }
    if (Date.now() > until) return null;
    if (!waited) {
      log("info", "build " + id + ": another bench is building it, waiting");
      waited = true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); // a blocking 200 ms nap: the build is synchronous anyway
  }
}

module.exports = { takeBuildLock, BUILD_LOCK_WAIT_MS, BUILD_LOCK_STALE_MS };
