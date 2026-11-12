"use strict";
/**
 * The toggles playground (serve.js /play): the model drawn live, with a checkbox per expression (.exp3.json) and
 * sliders for the face and body parameters the HUD's bake poses. For choosing which expressions to bake; it writes
 * nothing.
 *
 * It borrows page.js's loader and renderer (borrow.js), so the two never drift apart.
 */

/** The face and body parameters the bake poses (tools/live2d_bake/example.json), and the breath. */
const SLIDERS = [
  "ParamAngleX",
  "ParamAngleY",
  "ParamAngleZ",
  "ParamBodyAngleX",
  "ParamBodyAngleY",
  "ParamBodyAngleZ",
  "ParamEyeLOpen",
  "ParamEyeROpen",
  "ParamEyeLSmile",
  "ParamEyeRSmile",
  "ParamEyeBallX",
  "ParamEyeBallY",
  "ParamBrowLY",
  "ParamBrowRY",
  "ParamMouthForm",
  "ParamMouthOpenY",
  "ParamBreath",
];

/** The model's own switches the pose and outfit expressions set (0 off, 1 on), to mix them by hand. */
const SWITCHES = [
  "armshiddenR",
  "armshidden2",
  "Pose1",
  "Pose2",
  "Pose3",
  "pose4",
  "pose5",
  "pose6",
  "pose7",
  "pose8",
  "xf22",
  "SchoolUniform",
  "UniformMagicEyes",
];

const BOX_MARGIN = 0.04; // margin round her idle box, of its height
const SLIDER_STEPS = 100; // steps across a slider's range

(async () => {
  const logLine = (/** @type {string} */ text) => {
    const el = document.getElementById("log");
    if (el) el.textContent = text;
  };
  try {
    await borrowPage();
    /* global loadModel, Renderer, setParams, expressionParams, bounds */
    const g = /** @type {*} */ (window);
    const loaded = await g.loadModel();
    const params = loaded.model.parameters;
    const names = /** @type {string[]} */ (
      await (await fetch("/expressions.json")).json()
    );
    const renderer = new /** @type {*} */ (window.eval("Renderer"))(loaded);
    /** @type {Record<string, number>} */
    const values = {};
    /** @type {Set<string>} */
    const on = new Set();
    // the box from the idle pose, kept fixed so toggles don't rescale her
    g.setParams(loaded, {});
    loaded.model.update();
    const b = g.bounds(loaded);
    const pad = (b[3] - b[1]) * BOX_MARGIN;
    const box = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    const big = /** @type {HTMLCanvasElement} */ (
      document.getElementById("big")
    );
    const aspect = (box[2] - box[0]) / (box[3] - box[1]);
    big.width = Math.round(big.height * aspect);
    let pending = false;
    const draw = async () => {
      if (pending) return;
      pending = true;
      const exp = await g.expressionParams(Array.from(on));
      g.setParams(loaded, Object.assign({}, exp, values));
      loaded.model.update();
      const canvas = renderer.draw(big.width, big.height, box);
      const bctx = /** @type {CanvasRenderingContext2D} */ (
        big.getContext("2d")
      );
      bctx.clearRect(0, 0, big.width, big.height);
      bctx.imageSmoothingQuality = "high";
      bctx.drawImage(canvas, 0, 0, big.width, big.height);
      pending = false;
      logLine(
        (on.size
          ? "on: " + Array.from(on).map(label).join(", ")
          : "no expressions") +
          (Object.keys(values).length
            ? "; " +
              Object.keys(values)
                .map((id) => id.replace(/^Param/, "") + " " + values[id])
                .join(", ")
            : ""),
      );
    };
    /** @type {(file: string) => string} */
    const label = (file) => file.replace(/\.exp3\.json$/, "");
    const toggles = /** @type {HTMLElement} */ (
      document.getElementById("toggles")
    );
    names.forEach((file) => {
      const row = document.createElement("label"),
        box = document.createElement("input");
      box.type = "checkbox";
      box.addEventListener("change", () => {
        if (box.checked) on.add(file);
        else on.delete(file);
        draw();
      });
      row.appendChild(box);
      row.appendChild(document.createTextNode(label(file)));
      toggles.appendChild(row);
    });
    const sliders = /** @type {HTMLElement} */ (
      document.getElementById("sliders")
    );
    /** @type {{ input: HTMLInputElement, out: HTMLOutputElement, def: number }[]} */
    const inputs = [];
    /** @type {(id: string, into: HTMLElement) => void} */
    const addSlider = (id, into) => {
      const i = params.ids.indexOf(id);
      if (i < 0) return;
      const row = document.createElement("label"),
        input = document.createElement("input"),
        out = document.createElement("output"),
        def = params.defaultValues[i];
      input.type = "range";
      input.min = String(params.minimumValues[i]);
      input.max = String(params.maximumValues[i]);
      input.step = String(
        (params.maximumValues[i] - params.minimumValues[i]) / SLIDER_STEPS,
      );
      input.value = String(def);
      out.textContent = def.toFixed(2);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = v.toFixed(2);
        // kept even at the default, so a slider can override what an expression sets
        values[id] = Math.round(v * 100) / 100;
        draw();
      });
      row.appendChild(document.createTextNode(id.replace(/^Param/, "")));
      row.appendChild(input);
      row.appendChild(out);
      into.appendChild(row);
      inputs.push({ input, out, def });
    };
    SLIDERS.forEach((id) => addSlider(id, sliders));
    const switches = /** @type {HTMLElement} */ (
      document.getElementById("switches")
    );
    SWITCHES.forEach((id) => addSlider(id, switches));
    const clearExpressions = () => {
      on.clear();
      toggles
        .querySelectorAll("input")
        .forEach((el) => /** @type {HTMLInputElement} */ (el.checked = false));
    };
    /** @type {HTMLElement} */ (document.getElementById("clear")).onclick =
      () => {
        clearExpressions();
        draw();
      };
    /** @type {HTMLElement} */ (document.getElementById("reset")).onclick =
      () => {
        clearExpressions();
        Object.keys(values).forEach((id) => delete values[id]);
        inputs.forEach(({ input, out, def }) => {
          input.value = String(def);
          out.textContent = def.toFixed(2);
        });
        draw();
      };
    await draw();
  } catch (err) {
    logLine("ERROR: " + ((err && /** @type {*} */ (err).stack) || err));
  }
})();
