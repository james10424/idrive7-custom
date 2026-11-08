'use strict';
/**
 * HUD side-slot probe (run on the car, by hand): can our layer show in BMW's HUD pop-up slot 0x322 while BMW's route
 * guidance shows in 0x300? Our main HUD slot 0x323 switches 0x300 off (the slot table, X3, Nov 7 2026); 0x322 stayed
 * enabled. Needs cluster-render's map target pointed at 0x322 by tools/hud_side_probe.conf in its local conf.
 *
 *   node hud_side_probe.js [seconds=60]
 *
 * Draws on target "map" (its size from the conf): a white frame round the whole scene, a coloured square in each
 * corner (top-left red, top-right green, bottom-left blue, bottom-right yellow) and a white bar across the middle,
 * so a photo shows where the slot sits on the windshield, whether it is cropped or scaled, and which way is up. It logs
 * the target's state as cluster-render reports it.
 */
const { ClusterRender } = require('/var/opt/cluster-render/current/cluster_render_client.js');

const W = Number(process.env.SIDE_W) || 800, H = Number(process.env.SIDE_H) || 480;
const secs = Number(process.argv[2]) || 60;

function picture() {
    const px = Buffer.alloc(W * H * 4, 0);
    const fill = (x0, y0, w, h, c) => {
        for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++)
            for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
                const o = (y * W + x) * 4;
                px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
            }
    };
    const white = [240, 240, 240];
    fill(0, 0, W, 4, white); fill(0, H - 4, W, 4, white); fill(0, 0, 4, H, white); fill(W - 4, 0, 4, H, white);
    const s = Math.round(Math.min(W, H) / 6);
    fill(8, 8, s, s, [255, 40, 40]); fill(W - 8 - s, 8, s, s, [40, 220, 80]);
    fill(8, H - 8 - s, s, s, [60, 110, 255]); fill(W - 8 - s, H - 8 - s, s, s, [255, 210, 30]);
    fill(Math.round(W * 0.2), Math.round(H / 2) - 6, Math.round(W * 0.6), 12, white);
    return px;
}

const TARGET = process.env.SIDE_TARGET || 'map';
const cr = new ClusterRender('hud_side_probe');
const ref = cr.image({ target: TARGET, klass: 'overlay', z: 0, x: 0, y: 0, w: W, h: H, iw: W, ih: H });
cr.on('ready', () => { console.log('connected; drawing ' + W + 'x' + H + ' on target ' + TARGET); cr.pixels(ref, null, picture()); });
cr.on('target', (name, state, holder, reason) => console.log('target ' + name + ': ' + state + (holder ? ' (holder ' + holder + ')' : '') + (reason ? ': ' + reason : '')));
cr.on('layer', (r, state, reason) => console.log('layer ' + r + ': ' + state + (reason ? ': ' + reason : '')));
cr.on('refused', (op, r, reason) => console.log('refused ' + op + ' ' + r + ': ' + reason));
cr.connect();
setTimeout(() => { console.log('done'); cr.close(); process.exit(0); }, secs * 1000);
