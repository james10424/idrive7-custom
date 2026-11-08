'use strict';
/**
 * Layouts ({ schemaVersion: 2, name, theme?, modes?, widgets[] }), for the HUD or the cluster. The built-in ones are
 * hud/layouts/<name>.json (packed into hud.pack by the build). A file of the same
 * name in the app's data folder, <data>/layouts/<name>.json, overrides it: that is
 * where scripts/deploy.sh pushes an edited layout, and the folder is watched, so
 * the HUD picks it up without a restart. Which layout shows is the "hudLayout"
 * setting. Every layout is checked before use; a bad one is refused with the reason.
 */
const fs = require('fs');
const path = require('path');
const data = require('./hud_data');
const visible = require('./visible');

const TYPES = {
    text: ['text', 'font'],
    scale: ['font'],
    stripe: [],
    shiftbar: [],
    arc: ['signal', 'min', 'max'],
    revbar: ['barH'],
    lights: [],
    badge: ['text', 'font', 'tone'],
    fill: [],
    box: [],
    grid: [],
    gridlabels: ['font'],
    segbar: ['signal', 'max'],
    mdash: [],
    sdash: ['geo', 'k', 'band', 'ticks', 'fuelSeg', 'oilSeg', 'strip', 'topEnd'],
    rdash: ['spd', 'podL', 'ctr'],
    mtach: ['side', 'y0', 'y8', 'ym', 'xm', 'kTop', 'kBot', 'wBot', 'wTop'],
    icon: ['icon'],
    swatch: [],
    swatchimg: [],
    boxes: ['boxes'],
    atext: ['text', 'font'],
};
const CLASSES = ['ambient', 'content', 'overlay', 'alert'];
// the HUD modes a layout can have a variant for (hud.js header); "normal" is every layout's own
const MODES = ['cruise', 'nav', 'cruiseNav'];

class Layouts {
    /** size: the target's [w, h] (800x480 HUD, 1920x720 cluster); widgets must fit on it. */
    constructor(dataDir, log, size) {
        this.size = size || [800, 480];
        this.dir = path.join(dataDir, 'layouts');
        this.log = log;
        this.changeListeners = [];
        this._watch();
    }

    /** The layout called `name`, checked; throws with the reason when it can't be used. */
    load(name) {
        if (!/^[a-z0-9_-]+$/i.test(String(name))) throw new Error('bad layout name "' + name + '"');
        const own = path.join(this.dir, name + '.json');
        let raw;
        if (fs.existsSync(own)) {
            try {
                raw = JSON.parse(fs.readFileSync(own, 'utf8'));
            } catch (e) {
                throw new Error('layouts/' + name + '.json is not valid JSON (' + e.message + ')');
            }
        } else {
            raw = data.json('layouts/' + name + '.json');
            if (!raw || !Object.keys(raw).length) throw new Error('there is no layout "' + name + '"');
        }
        this._validate(raw, name);
        // Warn (never refuse) about widgets the driver cannot see: under the hood, under BMW's
        // gear box or belt light on the cluster, outside the windshield window on the HUD.
        const target = this.size[0] === 1920 ? 'panel' : 'hud';
        visible.check(raw.widgets, target).forEach((w) => this.log.warn('layout "' + name + '": ' + w));
        return raw;
    }

    _validate(p, name) {
        const bad = (why) => { throw new Error('layout "' + name + '": ' + why); };
        if (!p || typeof p !== 'object') bad('not an object');
        if (p.schemaVersion !== 2) bad('schemaVersion must be 2 (got ' + p.schemaVersion + ')');
        if (!Array.isArray(p.widgets)) bad('missing widgets array');
        if (p.modes !== undefined && !(Array.isArray(p.modes) && p.modes.every((m) => MODES.indexOf(m) >= 0))) bad('"modes" must list some of ' + MODES.join(', '));
        const ids = {};
        p.widgets.forEach((w, i) => {
            const at = 'widgets[' + i + '] ("' + w.id + '")';
            if (!w.id) bad('widgets[' + i + '] has no id');
            if (ids[w.id]) bad('two widgets are called "' + w.id + '"');
            ids[w.id] = true;
            if (!TYPES[w.type]) bad(at + ' has unknown type "' + w.type + '"');
            ['x', 'y', 'w', 'h'].forEach((k) => { if (typeof w[k] !== 'number' || w[k] < 0) bad(at + ' needs a number ' + k); });
            if (w.x + w.w > this.size[0] || w.y + w.h > this.size[1]) bad(at + ' runs off the ' + this.size[0] + 'x' + this.size[1] + ' display');
            if (w.class && CLASSES.indexOf(w.class) < 0) bad(at + ' has unknown class "' + w.class + '"');
            if (w.exclusive) bad(at + ' sets exclusive, which would hide everything under it (the CarPlay / Android Auto map too)');
            if (w.conn !== undefined && !(Number.isInteger(w.conn) && w.conn >= 0 && w.conn <= 3)) bad(at + ' "conn" must be 0..3 (the connection to cluster-render)');
            if (w.toggle !== undefined && !/^!?[a-zA-Z0-9_]+(=[a-zA-Z0-9_]+)?$/.test(String(w.toggle))) bad(at + ' has a bad toggle "' + w.toggle + '"');
            if (w.in !== undefined) {
                if (!w.in || typeof w.in !== 'object' || Array.isArray(w.in)) bad(at + ' "in" must be { mode: { fields } | false }');
                Object.keys(w.in).forEach((m) => {
                    const o = w.in[m];
                    if (m !== 'normal' && MODES.indexOf(m) < 0) bad(at + ' "in" has unknown mode "' + m + '" (normal, ' + MODES.join(', ') + ')');
                    if (o === false) return;
                    if (!o || typeof o !== 'object' || Array.isArray(o) || o.id !== undefined || o.type !== undefined || o.in !== undefined) bad(at + ' "in".' + m + ' must be false or fields to change (not id, type or in)');
                    const v = Object.assign({}, w, o);
                    ['x', 'y', 'w', 'h'].forEach((k) => { if (typeof v[k] !== 'number' || v[k] < 0) bad(at + ' in ' + m + ' needs a number ' + k); });
                    if (v.x + v.w > this.size[0] || v.y + v.h > this.size[1]) bad(at + ' in ' + m + ' runs off the ' + this.size[0] + 'x' + this.size[1] + ' display');
                });
            }
            if (w.hole !== undefined && !(Array.isArray(w.hole) && w.hole.length === 4 && w.hole.every((n) => typeof n === 'number'))) bad(at + ' "hole" must be [x, y, w, h]');
            TYPES[w.type].forEach((k) => { if (w[k] === undefined) bad(at + ' (' + w.type + ') needs "' + k + '"'); });
        });
    }

    /** cb() after <data>/layouts/ changes on disk. */
    onChange(cb) { this.changeListeners.push(cb); }

    _watch() {
        try { fs.mkdirSync(this.dir); } catch (e) { /* there already, or the data folder is read-only */ }
        try {
            fs.watch(this.dir, { persistent: false }, () => {
                // debounce: an rsync push touches several files in quick succession
                clearTimeout(this._timer);
                this._timer = setTimeout(() => {
                    this.log.info('layouts/ changed on disk, reloading');
                    this.changeListeners.forEach((cb) => { try { cb(); } catch (e) { this.log.warn('layouts listener: ' + e); } });
                }, 300);
            });
        } catch (e) {
            this.log.warn('layouts: cannot watch ' + this.dir + ' (' + e.message + '); a pushed layout shows after an app restart');
        }
    }
}

module.exports = Layouts;
