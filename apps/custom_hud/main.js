"use strict";
/**
 * Custom HUD: custom widgets on the iDrive 7 windshield HUD, drawn through cluster-render.
 *
 * The center screen is the app's settings page (app.json "screens" MAIN, a menu with
 * "settings": true): a status line, then layout, theme, units, redline and which widgets
 * show. The kit builds that page and saves each choice in the app's data/settings.json;
 * hud.js listens and redraws the HUD at once. The HUD keeps running after the page is
 * closed (OAP apps stay up in the background), so the page is only needed for changes.
 *
 * Under the status, the head unit's CPU (all of it, and ours) and the processor's temperature (usage.js): sampled
 * every USAGE_MS while the page is shown, and at once on Refresh; nothing is read while it's closed.
 */
const mgu = require("./kit/mgu");
const HudApp = require("./hud");
const usage = require("./usage");

const USAGE_MS = 5000; // the CPU and temperature row's refresh while the page is shown
const USAGE_FIRST_MS = 1000; // the first CPU figure after the page opens (or a Refresh right after a sample)
const PAGE = "MAIN";

/**
 * The CPU and temperature row on the settings page.
 * @param {*} ui the kit's ctx.ui
 */
function usageRows(ui) {
  const u = new usage.Usage();
  /** @type {?NodeJS.Timer} */
  let timer = null;
  let lastAt = 0;
  const show = () => {
    lastAt = Date.now();
    ui.text("CPU", usage.row(u.sample()));
  };
  /** @type {(ms: number) => void} the next sample in ms, then every USAGE_MS */
  const schedule = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!ui.isVisible(PAGE)) return;
      show();
      schedule(USAGE_MS);
    }, ms);
  };
  const open = () => {
    show(); // a fresh window: the CPU says "measuring" until the next sample
    schedule(USAGE_FIRST_MS);
  };
  ui.onVisible((/** @type {string} */ name, /** @type {boolean} */ v) => {
    if (name !== PAGE) return;
    if (v) open();
    else if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
  ui.onClick("BTN_REFRESH", () => {
    // a window under a second says little: wait for one
    if (Date.now() - lastAt < USAGE_FIRST_MS) schedule(USAGE_FIRST_MS);
    else {
      show();
      schedule(USAGE_MS);
    }
  });
  if (ui.isVisible(PAGE)) open();
}

mgu.run({
  /** @param {import("../../shared/hud").HudCtx} ctx the kit's app context */
  start(ctx) {
    let hud;
    try {
      hud = new HudApp(ctx);
    } catch (err) {
      // no HUD, but stay up: an exit here would count as a crash on the car
      ctx.log.error("HUD failed to start: " + ((err && err.stack) || err));
      ctx.ui.text(
        "STATUS",
        "HUD failed to start: " + ((err && err.message) || err),
      );
      return;
    }
    // the status row, and under it why layers aren't drawn (waiting, refused), so the long reason isn't cut off
    hud.onStatus((status, detail) => {
      ctx.ui.text("STATUS", status);
      ctx.ui.text("DETAIL", detail || " ");
    });
    hud.start();
    usageRows(ctx.ui);
    process.on("exit", () => {
      try {
        hud.stop();
      } catch (err) {
        /* exiting anyway */
      }
    });
  },
});
