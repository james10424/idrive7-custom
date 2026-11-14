'use strict';
/**
 * Which of an app's SOME/IP proxies BMW's installer refuses (run on the car, Node 8). MainApp builds an app's
 * someipInterfaces/ and acl.json from its manifest with the firmware's own generator, and refuses the whole install
 * or update (UPDATE_FAILED) when that throws for any one entry. This runs the same generator (kit/tools/oapgen/gen.js,
 * next to this file on the car) once per proxy entry, against the car's catalog, and says which pass.
 *
 *   node someip_manifest_check.js <manifest.json> [catalog]   (catalog: /etc/oap/someip/someip-interfaces.json)
 *
 * Writes nothing outside /tmp. Exit 1 if any entry fails.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const [manifestPath, catalogPath] = process.argv.slice(2);
if (!manifestPath) {
    console.error('usage: node someip_manifest_check.js <manifest.json> [catalog]');
    process.exit(2);
}
const catalog = catalogPath || '/etc/oap/someip/someip-interfaces.json';
const gen = require(path.join(__dirname, 'gen.js'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const db = JSON.parse(fs.readFileSync(catalog, 'utf8'));
const proxies = manifest.proxies || {};
let failed = 0;
Object.keys(proxies).forEach((iface, i) => {
    const one = Object.assign({}, manifest, { proxies: { [iface]: proxies[iface] } });
    const dir = path.join(os.tmpdir(), 'someip-check-' + process.pid + '-' + i);
    const file = dir + '.json';
    fs.writeFileSync(file, JSON.stringify(one));
    const inCatalog = !!(db.interfaces && db.interfaces[iface]);
    try {
        const log = console.log;
        console.log = () => {};
        try {
            gen.main([catalog, file, '12226', dir]);
        } finally {
            console.log = log;
        }
        console.log('ok    ' + iface + ' ' + JSON.stringify(proxies[iface]));
    } catch (err) {
        failed++;
        console.log('FAIL  ' + iface + ' ' + JSON.stringify(proxies[iface]) + (inCatalog ? '' : ' (not in this car\'s catalog)') +
            '\n      ' + String(err && err.stack || err).split('\n').slice(0, 3).join('\n      '));
    }
    try {
        fs.unlinkSync(file);
        fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
        fs.rmdirSync(dir);
    } catch (err) { /* nothing written */ }
});
console.log(failed ? failed + ' of ' + Object.keys(proxies).length + ' refused' : 'all ' + Object.keys(proxies).length + ' pass');
process.exit(failed ? 1 : 0);
