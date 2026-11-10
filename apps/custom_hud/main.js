"use strict";
/**
 * Custom HUD: custom widgets on the iDrive 7 windshield HUD, drawn through cluster-render.
 *
 * The center screen is the app's settings page (app.json "screens" MAIN, a menu with
 * "settings": true): a status line, then layout, theme, units, redline and which widgets
 * show. The kit builds that page and saves each choice in the app's data/settings.json;
 * hud.js listens and redraws the HUD at once. The HUD keeps running after the page is
 * closed (OAP apps stay up in the background), so the page is only needed for changes.
 */
const mgu = require("./kit/mgu");
const HudApp = require("./hud");

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
    process.on("exit", () => {
      try {
        hud.stop();
      } catch (err) {
        /* exiting anyway */
      }
    });
  },
});
