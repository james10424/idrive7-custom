#!/usr/bin/env node
'use strict';
/**
 * Bakes the Perch layout's frames from a Live2D (Cubism 3+) model you own, on your own machine.
 *
 *   node tools/live2d_bake/serve.js --model <...>/Model.model3.json --core <...>/live2dcubismcore.min.js \
 *       --config <bake config .json> --out <folder> [--port 8095]
 *
 * then open http://localhost:8095/ in a browser: the page renders the model, standing, with Live2D's Cubism Core (which
 * you get from Live2D's Cubism SDK for Web under their license; it is not in this repo) and writes <out>/atlas.json,
 * atlas.rgba and preview.png. Push them with scripts/deploy.sh <car> --perch <out>.
 * http://localhost:8095/?inspect shows the model with its parts, parameters and drawables, to write the config.
 *
 * Nothing of the model ever goes in this repo: keep the config and the output next to the model.
 * The config's fields are described in page.js (CONFIG).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const model = arg('model'), core = arg('core'), config = arg('config'), out = arg('out'), port = Number(arg('port', 8095));
if (!model || !core || !out) {
    console.error('usage: node tools/live2d_bake/serve.js --model <model3.json> --core <live2dcubismcore.min.js> --config <bake.json> --out <folder> [--port 8095]');
    process.exit(1);
}
const modelDir = path.dirname(path.resolve(model));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.moc3': 'application/octet-stream' };

function send(res, file) {
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(buf);
    });
}

http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (req.method === 'POST' && u.indexOf('/out/') === 0) {
        // /out/<file> (or /out/inspect/<file>): written under --out, nowhere else
        const rel = path.normalize(u.slice(5));
        if (rel.startsWith('..') || path.isAbsolute(rel) || !/^(inspect\/)?[\w.-]+$/.test(rel)) { res.writeHead(400); res.end('bad path'); return; }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const dest = path.join(out, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, Buffer.concat(chunks));
            console.log('wrote ' + dest + ' (' + Buffer.concat(chunks).length + ' bytes)');
            res.end('ok');
        });
        return;
    }
    if (u === '/' ) return send(res, path.join(__dirname, 'page.html'));
    if (u === '/page.js') return send(res, path.join(__dirname, 'page.js'));
    if (u === '/core.js') return send(res, path.resolve(core));
    if (u === '/model.json') return send(res, path.resolve(model));
    if (u === '/config.json') return config ? send(res, path.resolve(config)) : (res.writeHead(200), res.end('{}'));
    if (u.indexOf('/model/') === 0) {
        const rel = path.normalize(u.slice(7));
        if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(400); res.end('bad path'); return; }
        return send(res, path.join(modelDir, rel));
    }
    res.writeHead(404); res.end('not found');
}).listen(port, '127.0.0.1', () => console.log('bake page: http://localhost:' + port + '/   (inspect: http://localhost:' + port + '/?inspect)'));
