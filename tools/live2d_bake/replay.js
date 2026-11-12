"use strict";
/**
 * The replay page (serve.js /replay): plays a clip recorded from VTube Studio (vts_record.js) on the model, as the
 * bake would pose it: play, pause, scrub, step frames, slow down, with or without VTube Studio's physics. It writes
 * nothing. Values between two recorded frames are blended linearly.
 */
(() => {
  const BOX_MARGIN = 0.04; // margin round her idle box, of its height
  const SEEK_STEPS = 1000; // the scrubber's steps over the clip
  const LIVE_PARAMS = [
    "ParamAngleX",
    "ParamAngleY",
    "ParamAngleZ",
    "ParamBodyAngleX",
    "ParamEyeLOpen",
    "ParamEyeROpen",
    "ParamMouthOpenY",
    "ParamMouthForm",
  ];

  /** @param {string} id @returns {HTMLElement} */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const logLine = (/** @type {string} */ text) => ($("log").textContent = text);

  /**
   * @typedef {object} Clip
   * @property {{ name: string, id: string }} model
   * @property {number} fps
   * @property {string[]} names
   * @property {Array<{ t: number, v: number[] }>} frames
   */

  (async () => {
    try {
      await borrowPage();
      const g = /** @type {*} */ (window);
      const loaded = await g.loadModel();
      const ids = /** @type {string[]} */ (loaded.model.parameters.ids);
      const renderer = new (window.eval("Renderer"))(loaded);

      // the physics outputs (model3.json's physics file): what VTube Studio's physics set, not what you acted
      /** @type {Set<string>} */
      const physicsOut = new Set();
      const physicsFile = loaded.m3.FileReferences.Physics;
      if (physicsFile) {
        const physics = await (await fetch("/model/" + encodeURI(physicsFile))).json();
        (physics.PhysicsSettings || []).forEach((/** @type {*} */ setting) =>
          (setting.Output || []).forEach((/** @type {*} */ output) => physicsOut.add(output.Destination.Id)),
        );
      }

      // the box from the idle pose, kept fixed so the motion doesn't rescale her
      g.setParams(loaded, {});
      loaded.model.update();
      const b = g.bounds(loaded);
      const pad = (b[3] - b[1]) * BOX_MARGIN;
      const box = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
      const big = /** @type {HTMLCanvasElement} */ ($("big"));
      big.width = Math.round((big.height * (box[2] - box[0])) / (box[3] - box[1]));
      const bctx = /** @type {CanvasRenderingContext2D} */ (big.getContext("2d"));

      /** @type {Clip | null} */
      let clip = null;
      /** @type {number[]} the clip's columns this model has (index into clip.names) */
      let cols = [];
      let t = 0,
        playing = false,
        lastNow = 0;
      const duration = () => (clip && clip.frames.length ? clip.frames[clip.frames.length - 1].t : 0);

      /** The values at time ms, blended between the two frames around it. @param {number} ms */
      const valuesAt = (ms) => {
        if (!clip) return {};
        const frames = clip.frames;
        let lo = 0,
          hi = frames.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (frames[mid].t <= ms) lo = mid;
          else hi = mid;
        }
        const a = frames[lo],
          c = frames[hi];
        const f = c.t > a.t ? Math.min(1, Math.max(0, (ms - a.t) / (c.t - a.t))) : 0;
        const phys = /** @type {HTMLInputElement} */ ($("phys")).checked;
        /** @type {Record<string, number>} */
        const out = {};
        cols.forEach((k) => {
          const name = /** @type {Clip} */ (clip).names[k];
          if (!phys && physicsOut.has(name)) return;
          out[name] = a.v[k] + (c.v[k] - a.v[k]) * f;
        });
        return out;
      };

      const draw = () => {
        const values = valuesAt(t);
        g.setParams(loaded, values);
        loaded.model.update();
        const canvas = renderer.draw(big.width, big.height, box);
        bctx.clearRect(0, 0, big.width, big.height);
        bctx.imageSmoothingQuality = "high";
        bctx.drawImage(canvas, 0, 0, big.width, big.height);
        const d = duration();
        $("time").textContent = (t / 1000).toFixed(2) + " / " + (d / 1000).toFixed(2) + " s";
        /** @type {HTMLInputElement} */ ($("seek")).value = String(d ? Math.round((t / d) * SEEK_STEPS) : 0);
        $("live").textContent = LIVE_PARAMS.filter((id) => id in values)
          .map((id) => id.replace(/^Param/, "").padEnd(14) + values[id].toFixed(2).padStart(7))
          .join("\n");
      };

      const tick = (/** @type {number} */ now) => {
        if (!playing) return;
        const speed = Number(/** @type {HTMLSelectElement} */ ($("speed")).value);
        t += (now - lastNow) * speed;
        lastNow = now;
        const d = duration();
        if (t >= d) {
          if (/** @type {HTMLInputElement} */ ($("loop")).checked && d > 0) t %= d;
          else {
            t = d;
            setPlaying(false);
          }
        }
        draw();
        if (playing) requestAnimationFrame(tick);
      };
      /** @param {boolean} on */
      const setPlaying = (on) => {
        playing = on;
        $("play").textContent = on ? "Pause" : "Play";
        if (on) {
          if (t >= duration()) t = 0;
          lastNow = performance.now();
          requestAnimationFrame(tick);
        }
      };

      /** @param {string} text @param {string} name the file's name */
      const openClip = (text, name) => {
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.names) || !Array.isArray(parsed.frames) || !parsed.frames.length)
          throw new Error(name + ": not a clip from vts_record.js");
        clip = parsed;
        const c = /** @type {Clip} */ (clip);
        cols = c.names.map((n, k) => (ids.indexOf(n) >= 0 ? k : -1)).filter((k) => k >= 0);
        const missing = c.names.filter((n) => ids.indexOf(n) < 0);
        const physCount = c.names.filter((n) => physicsOut.has(n)).length;
        $("info").textContent =
          name + ": " + c.model.name + ", " + c.frames.length + " frames, " + (duration() / 1000).toFixed(1) + " s, " +
          c.names.length + " parameters (" + physCount + " physics outputs)" +
          (missing.length ? "; not in this model, skipped: " + missing.join(", ") : "");
        ["play", "seek", "prev", "next"].forEach((id) => /** @type {HTMLButtonElement} */ ($(id)).removeAttribute("disabled"));
        t = 0;
        logLine("replaying " + name);
        draw();
        setPlaying(true);
      };
      /** @param {File} file */
      const readFile = (file) =>
        file.text().then((text) => openClip(text, file.name)).catch((err) => logLine("ERROR: " + err.message));

      /** @type {HTMLInputElement} */ ($("file")).addEventListener("change", (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.files && input.files[0]) readFile(input.files[0]);
      });
      // the whole window takes a dropped clip (dropped anywhere else, the browser would open the file instead)
      let dragDepth = 0;
      const showDrop = (/** @type {boolean} */ on) => document.body.classList.toggle("drop", on);
      document.addEventListener("dragenter", (event) => {
        event.preventDefault();
        dragDepth++;
        showDrop(true);
      });
      document.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      });
      document.addEventListener("dragleave", () => {
        if (--dragDepth <= 0) {
          dragDepth = 0;
          showDrop(false);
        }
      });
      document.addEventListener("drop", (event) => {
        event.preventDefault();
        dragDepth = 0;
        showDrop(false);
        const file = event.dataTransfer && event.dataTransfer.files[0];
        if (file) readFile(file);
      });
      $("play").addEventListener("click", () => setPlaying(!playing));
      $("seek").addEventListener("input", (event) => {
        setPlaying(false);
        t = (Number(/** @type {HTMLInputElement} */ (event.target).value) / SEEK_STEPS) * duration();
        draw();
      });
      /** @param {number} dir */
      const step = (dir) => {
        if (!clip) return;
        setPlaying(false);
        const frames = clip.frames;
        let i = frames.findIndex((frame) => frame.t > t + 0.5);
        if (i < 0) i = frames.length;
        i = dir > 0 ? Math.min(frames.length - 1, i) : Math.max(0, i - 2);
        t = frames[i].t;
        draw();
      };
      $("prev").addEventListener("click", () => step(-1));
      $("next").addEventListener("click", () => step(1));
      $("phys").addEventListener("change", draw);
      document.addEventListener("keydown", (event) => {
        if (!clip || /** @type {HTMLElement} */ (event.target).tagName === "INPUT" && event.key !== " ") return;
        if (event.key === " ") {
          event.preventDefault();
          setPlaying(!playing);
        } else if (event.key === "ArrowLeft") step(-1);
        else if (event.key === "ArrowRight") step(1);
      });

      draw();
      logLine("open a clip (vts_record.js): drop it anywhere on the page or pick it on the right. Space: play, arrows: frames");
    } catch (err) {
      logLine("ERROR: " + ((err && /** @type {*} */ (err).stack) || err));
    }
  })();
})();
