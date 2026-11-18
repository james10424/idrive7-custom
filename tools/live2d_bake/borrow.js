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

/**
 * Fills the page's model dropdown (<select id="model">) with the models serve.js has (--models), and switches by
 * setting its cookie and reloading. Hidden when there's only one.
 * @param {() => void} [beforeSwitch] keeps what the page wants back after the reload
 * @returns {Promise<void>}
 */
async function modelSwitch(beforeSwitch) {
  const select = /** @type {HTMLSelectElement | null} */ (document.getElementById("model"));
  if (!select) return;
  const list = await (await fetch("/models.json")).json();
  if (list.models.length < 2) {
    /** @type {HTMLElement} */ (select.parentElement || select).style.display = "none";
    return;
  }
  list.models.forEach((/** @type {string} */ name) => {
    const option = document.createElement("option");
    option.value = option.textContent = name;
    option.selected = name === list.current;
    select.appendChild(option);
  });
  select.addEventListener("change", () => {
    if (beforeSwitch) beforeSwitch();
    document.cookie = list.cookie + "=" + encodeURIComponent(select.value) + "; path=/; max-age=31536000; samesite=strict";
    location.reload();
  });
}
