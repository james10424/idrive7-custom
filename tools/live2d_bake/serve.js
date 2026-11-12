#!/usr/bin/env node
"use strict";
/**
 * Bakes the Miku layout's frames from a Live2D (Cubism 3+) model you own, on your own machine.
 *
 *   node tools/live2d_bake/serve.js --model <...>/Model.model3.json --core <...>/live2dcubismcore.min.js \
 *       --config <bake config .json> --out <folder> [--port 8095]
 *
 * then open http://localhost:8095/ in a browser: the page renders the model, standing, with Live2D's Cubism Core (which
 * you get from Live2D's Cubism SDK for Web under their license; it is not in this repo) and writes <out>/atlas.json,
 * atlas.rgba and preview.png. Push them with scripts/deploy.sh <car> --miku <out>.
 * http://localhost:8095/?inspect shows the model with its parts, parameters and drawables, to write the config;
 * http://localhost:8095/play is a playground: toggle the model's expressions and move its face and body parameters.
 * http://localhost:8095/replay plays a clip recorded from VTube Studio (vts_record.js) on the model.
 * --home play (or replay) serves that page at / as well (for a launcher that opens only the root); the bake page is
 * then at /bake (always there too).
 *
 * Nothing of the model ever goes in this repo: keep the config and the output next to the model.
 * The config's fields are described in page.js (CONFIG).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

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
const DEFAULT_PORT = 8095;
const OUT_PREFIX = "/out/",
  MODEL_PREFIX = "/model/";
const model = arg("model"),
  core = arg("core"),
  config = arg("config"),
  out = arg("out"),
  port = Number(arg("port", DEFAULT_PORT)),
  home = arg("home", "bake");
if (!model || !core || !out) {
  console.error(
    "usage: node tools/live2d_bake/serve.js --model <model3.json> --core <live2dcubismcore.min.js> --config <bake.json> --out <folder> [--port " +
      DEFAULT_PORT +
      "]",
  );
  process.exit(1);
}
const modelDir = path.dirname(path.resolve(model));
/** @type {Record<string, string>} --home: the page served at / */
const PAGES = { bake: "page.html", play: "play.html", replay: "replay.html" };
/** @type {Record<string, string>} extension to Content-Type */
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".moc3": "application/octet-stream",
};

/**
 * Serves a file, or 404.
 * @param {http.ServerResponse} res
 * @param {string} file
 */
function send(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (req.method === "POST" && urlPath.indexOf(OUT_PREFIX) === 0) {
      // /out/<file> (or /out/inspect/<file>): written under --out, nowhere else
      const rel = path.normalize(urlPath.slice(OUT_PREFIX.length));
      if (
        rel.startsWith("..") ||
        path.isAbsolute(rel) ||
        !/^(inspect\/)?[\w.-]+$/.test(rel)
      ) {
        res.writeHead(400);
        res.end("bad path");
        return;
      }
      /** @type {Buffer[]} */
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const dest = path.join(out, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.concat(chunks));
        console.log(
          "wrote " + dest + " (" + Buffer.concat(chunks).length + " bytes)",
        );
        res.end("ok");
      });
      return;
    }
    if (urlPath === "/")
      return send(res, path.join(__dirname, PAGES[home] || "page.html"));
    if (urlPath === "/bake") return send(res, path.join(__dirname, "page.html"));
    // the toggles playground: play.html, and the model's expressions (its .exp3.json files) for it to list
    if (urlPath === "/play")
      return send(res, path.join(__dirname, "play.html"));
    if (urlPath === "/play.js")
      return send(res, path.join(__dirname, "play.js"));
    // the replay page: a recorded clip played on the model
    if (urlPath === "/replay")
      return send(res, path.join(__dirname, "replay.html"));
    if (urlPath === "/replay.js")
      return send(res, path.join(__dirname, "replay.js"));
    // page.js's loader and renderer, for the playground and the replay page
    if (urlPath === "/borrow.js")
      return send(res, path.join(__dirname, "borrow.js"));
    if (urlPath === "/expressions.json") {
      const names = fs
        .readdirSync(modelDir)
        .filter((file) => /\.exp3\.json$/.test(file))
        .sort();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify(names));
    }
    if (urlPath === "/page.js")
      return send(res, path.join(__dirname, "page.js"));
    if (urlPath === "/core.js") return send(res, path.resolve(core));
    if (urlPath === "/model.json") return send(res, path.resolve(model));
    if (urlPath === "/config.json")
      return config
        ? send(res, path.resolve(config))
        : (res.writeHead(200), res.end("{}"));
    if (urlPath.indexOf(MODEL_PREFIX) === 0) {
      const rel = path.normalize(urlPath.slice(MODEL_PREFIX.length));
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        res.writeHead(400);
        res.end("bad path");
        return;
      }
      return send(res, path.join(modelDir, rel));
    }
    res.writeHead(404);
    res.end("not found");
  })
  .listen(port, "127.0.0.1", () =>
    console.log(
      (home !== "bake" ? home + " page: http://localhost:" + port + "/   (bake page: /bake)" : "bake page: http://localhost:" + port + "/") +
        "   (inspect: http://localhost:" +
        port +
        "/bake?inspect, playground: /play, replay: /replay)",
    ),
  );
