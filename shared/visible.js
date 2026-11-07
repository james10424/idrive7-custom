'use strict';
/**
 * What the driver can actually see of each target, measured from car photos (Nov 5 2026,
 * design/photos/calibration-2026-11-05.json next to the pictures). The renderer draws 1:1,
 * but parts of the panel are hidden by the car and parts of the HUD fall outside the
 * windshield window. Used by layouts.js (a warning per widget) and the bench (the car view).
 *
 * Plain Node 8 (the car's 8.16.2): no optional chaining, no ??, no dependencies.
 */

/** Cluster (1920x720): the first visible y along each vertical line [x, y]; the hood hides
 *  everything above it. Linear between points; x 1920 is taken as y 240. Bottom and sides
 *  are fully visible. */
const HOOD = [
    [0, 273], [100, 138], [200, 85], [300, 57], [400, 36], [500, 21], [600, 18], [700, 12], [800, 3], [900, 2],
    [1000, 1], [1100, 2], [1200, 5], [1300, 10], [1400, 19], [1500, 37], [1600, 67], [1700, 84], [1800, 128], [1900, 196],
    [1920, 240],
];
/** BMW draws a solid black box over our panel here (its gear slot): [x0, y0, x1, y1]. */
const BLACK_BOX = [1406, 342, 1597, 419];
/** BMW's seat-belt warning light is drawn over us here: [x0, y0, x1, y1]. */
const BELT = [587, 663, 626, 700];
/** The part of the 800x480 HUD target seen through the windshield (eye-position dependent). */
const HUD_WINDOW = { x: 120, y: 100, w: 485, h: 278 };

/** The first visible y at x on the panel (interpolated along HOOD). */
function hoodY(x) {
    if (x <= HOOD[0][0]) return HOOD[0][1];
    const last = HOOD[HOOD.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < HOOD.length; i++) {
        const a = HOOD[i - 1], b = HOOD[i];
        if (x <= b[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
    }
    return last[1];
}

function overlaps(w, box) {
    return w.x < box[2] && w.x + w.w > box[0] && w.y < box[3] && w.y + w.h > box[1];
}

/**
 * Warnings (strings, one per problem) for the widgets ({ id, x, y, w, h }) of a layout on
 * `target` ('panel' or 'hud'). Never throws; a widget without numeric x/y/w/h is skipped.
 */
function check(widgets, target) {
    const out = [];
    if (!Array.isArray(widgets)) return out;
    widgets.forEach((w) => {
        if (!w || typeof w.x !== 'number' || typeof w.y !== 'number' || typeof w.w !== 'number' || typeof w.h !== 'number') return;
        const id = String(w.id);
        if (target === 'panel') {
            // the top edge: both corners, then a few samples along it (the hood curve is not straight)
            const under = [];
            const tryX = (x, what) => {
                const d = Math.ceil(hoodY(x) - w.y);
                if (d > 0) under.push({ d, what });
            };
            tryX(w.x, 'top-left corner');
            tryX(w.x + w.w, 'top-right corner');
            const steps = 4;
            for (let i = 1; i < steps; i++) tryX(w.x + w.w * i / steps, 'top edge at x ' + Math.round(w.x + w.w * i / steps));
            if (under.length) {
                const worst = under.reduce((a, b) => (b.d > a.d ? b : a));
                out.push(id + ': ' + worst.what + ' ' + worst.d + ' px under the hood');
            }
            if (overlaps(w, BLACK_BOX)) {
                out.push(id + ': overlaps BMW\'s gear box x' + BLACK_BOX[0] + '-' + BLACK_BOX[2] + ' y' + BLACK_BOX[1] + '-' + BLACK_BOX[3]);
            }
            if (overlaps(w, BELT)) {
                out.push(id + ': overlaps BMW\'s seat-belt light x' + BELT[0] + '-' + BELT[2] + ' y' + BELT[1] + '-' + BELT[3]);
            }
        } else if (target === 'hud') {
            const win = HUD_WINDOW;
            const d = Math.max(
                win.x - w.x, win.y - w.y,
                (w.x + w.w) - (win.x + win.w), (w.y + w.h) - (win.y + win.h));
            if (d > 0) {
                out.push(id + ': ' + Math.ceil(d) + ' px outside the visible HUD window ' + win.x + ',' + win.y + ' ' + win.w + 'x' + win.h);
            }
        }
    });
    return out;
}

module.exports = { HOOD, BLACK_BOX, BELT, HUD_WINDOW, hoodY, check };
