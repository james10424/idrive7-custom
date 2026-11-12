"use strict";
/**
 * For the pages beside the bake (play.html, replay.html): page.js's loader and renderer, borrowed, so the pages never
 * drift from what the bake draws.
 */

/**
 * Runs page.js's definitions (everything but its closing bake call) as a classic script, so its classes and
 * functions are globals here.
 * @returns {Promise<void>}
 */
async function borrowPage() {
  const src = await (await fetch("/page.js")).text();
  const end = src.lastIndexOf("\n(async () => {");
  if (end < 0) throw new Error("page.js: its closing bake call not found");
  await new Promise((resolve) => {
    const script = document.createElement("script");
    script.textContent = src.slice(0, end) + "\nwindow.__pageReady = true;";
    document.body.appendChild(script);
    resolve(undefined);
  });
  if (!(/** @type {*} */ (window).__pageReady))
    throw new Error("page.js did not run");
}
