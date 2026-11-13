"use strict";
/* Miku bake page (served by serve.js): the standing frames. A small WebGL renderer on Live2D's Cubism Core: drawables in render order,
 * clipping masks through the stencil buffer, normal / additive / multiplicative blending, multiply and screen colours.
 * No physics: the model is posed by parameters only, and the HUD's shader adds the motion.
 *
 * CONFIG (the --config file, kept next to the model):
 *   params      { id: value } set on every frame (e.g. a watermark off, a toggle on)
 *   frames      { idle | half | shut | talk: { params: { id: value }, expressions: ["X.exp3.json"] } }: each frame's
 *               own parameters, on top of "params": the blink (eyes open, half, shut) and a smile with the mouth open
 *   lean        { steps: 11, params: { id: value at a full lean right }, left: { id: value }, right: { id: value },
 *               face: 0.6, axis: "side" }: her, standing on a bus, leaning with the model's body and head rotation, baked at "steps"
 *               angles from a full lean left (the car braking) to a full lean right (pulling away); each angle's params
 *               are "params" times -1 .. 1. From "face" on, the left ones add "left" (the braking face) and the right
 *               ones "right" (the happy face). Neighbouring angles are close enough to blend without a double image.
 *               "poses" instead of "params": each angle's own params, left to right without the upright middle
 *               (steps - 1 of them), for a lean that isn't the same both ways, such as one posed from a VTube Studio clip.
 *               axis "fb" bakes the forward/back lean instead (a bake of its own, for the HUD's "Miku lean" setting,
 *               deployed with --miku-fb): "params" then tip her back, away from you, at a full lean right (pulling
 *               away, pressed into the seat) and toward you at a full lean left (braking), e.g. ParamBodyAngleY and
 *               ParamAngleY; the bake also measures how far each angle moves her head up or down, for the tails.
 *               perspective { widen: 0.14, shorten: 0.1 } (fb only): above the waist she tips out of the screen, so
 *               at a full lean her upper body is "shorten" shorter and its top "widen" narrower leaning back (wider
 *               leaning toward you), for depth
 *   close       { size: [249, 278], window: [-124, -277, 249, 278], centre: [x, y], height, pivot: [x, y],
 *               expressions: ["X.exp3.json"], params: { id: value }, zoomSteps: 3, sway: { ParamAngleZ: 4 },
 *               turn: { ParamAngleX: 30 }, turnSteps: 2 }: the close-up the HUD zooms into when the car stops, in its
 *               own atlas (close.rgba), drawn at "size" px (the HUD window it fills). "window" is that window in HUD px
 *               from her feet (x, y, w, h), where the zoom starts; "centre" and "height" (model units) frame the
 *               close-up, its width from "size". On the way in the camera zooms evenly from the window to the
 *               close-up while "expressions" and "params" blend from the model's defaults to fully on, baked at
 *               "zoomSteps" points between. Zoomed in she sways ("sway" times -1 and 1) and turns her head toward the
 *               indicator ("turn": her looking toward the right of the screen, times -1 .. 1 over "turnSteps" each way;
 *               or "turnPoses": each step's own params, in the order -turnSteps .. -1, 1 .. turnSteps, for a turn that
 *               isn't the same both ways, such as one posed from a VTube Studio clip), every pose with its eyes open, half shut
 *               and shut (frames.half, frames.shut). "pivot" (model units) is what the sway turns about, which the
 *               HUD uses to line the baked steps up while it blends them
 *   tails       ["part id", ...]: drawn in their own sprite (swung by the HUD), hidden in the body frames
 *   tailsRoot   0..1: where the tails hang from, as a fraction down the tails sprite (0.15)
 *   anchor      [x, y] the model point between her feet (model units, y up, as ?inspect's grid shows them; the bottom
 *               middle of the figure when left out): it goes on
 *               the Miku widget's "feet" point; anchorPx [x, y] px added to it on the HUD (right, down)
 *   arms        [{ parts: ["part id"] }, ...] (up to 2): her arms, each its own sprite that the HUD turns from the
 *               shoulder (to point toward the indicator); left out of the body frames
 *   hide        ["part id"]: left out entirely
 *   cut         { "drawable id": model y }: that drawable's triangles wholly below the y left out (in the idle pose)
 *   heightPx    her height on the HUD in px (200), or pxPerUnit: HUD px per model unit
 *   waist       model y the upper body breathes above (40% down the figure)
 *   headY       model y across her face (15% down the figure): where the bake measures how far each lean moves her
 *               head, so the tails can follow it
 *   pad         px of transparent border round each sprite (2)
 */
const cubismCore = window.Live2DCubismCore;

/** @typedef {Record<string, number>} Params parameter id to value */
/** @typedef {[number, number, number, number]} Box [x0, y0, x1, y1] in model units, y up */
/** @typedef {[number, number, number, number]} Rect [x, y, w, h] in px */
/** @typedef {(i: number) => boolean} DrawablePick whether drawable i is in */
/** @typedef {{ params?: Params, expressions?: string[] }} FrameConfig */
/**
 * The --config file, with withDefaults() filled in (fields described in CONFIG above).
 * @typedef {object} BakeConfig
 * @property {Params} [params]
 * @property {Record<string, FrameConfig>} frames
 * @property {{ steps?: number, params?: Params, poses?: Params[], left?: Params, right?: Params, face?: number, axis?: string,
 *   perspective?: { widen?: number, shorten?: number } }} lean
 * @property {{ size?: number[], window?: number[], centre: number[], height: number, pivot: number[],
 *   expressions?: string[], params?: Params, zoomSteps?: number, sway?: Params, turn?: Params,
 *   turnSteps?: number, turnPoses?: Params[] }} [close]
 * @property {string[]} [tails]
 * @property {number} [tailsRoot]
 * @property {[number, number]} [anchor]
 * @property {[number, number]} [anchorPx]
 * @property {{ parts?: string[] }[]} [arms]
 * @property {string[]} [hide]
 * @property {Record<string, number>} [cut] drawable id to model y
 * @property {number} [heightPx]
 * @property {number} [pxPerUnit]
 * @property {number} [waist]
 * @property {number} [headY]
 * @property {number} [pad]
 */
/**
 * The loaded model: its model3.json, the Cubism Core model, its textures and display info.
 * @typedef {object} Loaded
 * @property {any} m3 the model3.json
 * @property {any} model a Live2DCubismCore.Model
 * @property {HTMLImageElement[]} imgs
 * @property {any} cdi the cdi3.json, or null
 * @property {Map<number, Uint16Array>} [cut] drawable index to the triangles it keeps (makeCuts)
 */
/** @typedef {{ only?: DrawablePick, skip?: DrawablePick }} DrawOpts */
/**
 * An arm at one pose: its shoulder P in frame px and the angle from it to the arm's middle.
 * @typedef {{ P: number[], ang: number }} ArmPose
 */
/**
 * A sprite to pack: its canvas, the rect of it to keep, and where that lands in the atlas.
 * @typedef {{ n: string, cv: HTMLCanvasElement, bb: number[], at?: number[] }} AtlasItem
 */
/**
 * atlas.json, what the HUD reads (positions in atlas px, offsets in frame px).
 * @typedef {object} AtlasInfo
 * @property {number} version
 * @property {number[]} atlas [w, h]
 * @property {number[]} frame [w, h]
 * @property {Record<string, number[]>} frames frame name to its top-left
 * @property {number[][]} lean
 * @property {number[]} anchor
 * @property {number} hipY
 * @property {number} headY
 * @property {number[]} leanShift
 * @property {"fb"} [leanAxis]
 * @property {number[]} [leanShiftY]
 * @property {Rect} [crop]
 * @property {Record<string, *>} [close] the close-up's atlas (bakeClose)
 * @property {{ rect: number[], at: number[], rootY: number, length: number }} [tails]
 * @property {{ rect: number[], at: number[], shoulder: number[], side: number, left: number[], right: number[] }[]} [arms]
 */

/* What a config leaves out: Live2D's standard parameter ids (most models use them; a missing one is skipped with a
 * note in the log). tools/live2d_bake/example.json is these written out, to start a config from. */
const DEFAULT_LEAN_STEPS = 11; // lean angles baked, left to right
const DEFAULT_LEAN_FACE = 0.6; // the lean from which the braking and happy faces show
/** @type {Partial<BakeConfig>} */
const DEFAULTS = {
  frames: {
    idle: {},
    half: { params: { ParamEyeLOpen: 0.45, ParamEyeROpen: 0.45 } },
    shut: { params: { ParamEyeLOpen: 0, ParamEyeROpen: 0 } },
    talk: { params: { ParamMouthOpenY: 0.5, ParamMouthForm: 1 } },
  },
  lean: {
    steps: DEFAULT_LEAN_STEPS,
    params: {
      ParamBodyAngleZ: 10,
      ParamAngleZ: 30,
      ParamBodyAngleX: 10,
      ParamAngleX: 12,
      ParamEyeBallX: 0.4,
    },
    left: {
      ParamMouthOpenY: 0.6,
      ParamMouthForm: -1,
      ParamBrowLY: -0.6,
      ParamBrowRY: -0.6,
    },
    right: {
      ParamEyeLSmile: 1,
      ParamEyeRSmile: 1,
      ParamEyeLOpen: 0,
      ParamEyeROpen: 0,
      ParamMouthForm: 1,
      ParamMouthOpenY: 0.7,
    },
    face: DEFAULT_LEAN_FACE,
  },
};
/**
 * @param {Partial<BakeConfig>} cfg
 * @returns {BakeConfig}
 */
function withDefaults(cfg) {
  const merged = Object.assign({}, cfg);
  merged.frames = Object.assign({}, DEFAULTS.frames, cfg.frames || {});
  merged.lean = Object.assign({}, DEFAULTS.lean, cfg.lean || {});
  return merged;
}
const logEl = /** @type {HTMLElement} */ (document.getElementById("log")),
  view = document.getElementById("view");
/** @param {string} line */
const log = (line) => {
  logEl.textContent += "\n" + line;
};
const SUPERSAMPLE = 4; // render this many times bigger than the frame, then scale down
const MIN_OPACITY = 0.001; // a drawable at or under this opacity counts as hidden
const ATLAS_MAX = 1024; // px a side: the instrument cluster (KOMBI) restarted on a 1024x1128 RGBA asset (Nov 2026)
// the close-up's atlas, ETC2 on the car: 2048x2048 draws, on the HUD and the cluster, seven at once (car tests, Nov 13
// 2026); the 1024x1128 restart above was the shader's reads, not the atlas. Used for close.turnSteps over 2 (more turn
// frames); with 2 or fewer the close-up stays 1024 wide, as the HUD up to 0.1.29 reads it
const CLOSE_ATLAS_MAX = 2048;
const ATLAS_MIN_W = 64;
const ETC2_BLOCK = 4; // serve.js compresses the atlases to ETC2 (tools/etc2.js), whose blocks are 4x4: heights round up
/** @param {number} px @returns {number} px rounded up to whole ETC2 blocks */
const ceilBlock = (px) => Math.ceil(px / ETC2_BLOCK) * ETC2_BLOCK; // the atlas width starts here and doubles until everything fits
const HUD_BYTES_PER_PX = 8; // what an atlas pixel takes of the HUD's pixel memory
const DEFAULT_PAD = 2; // px of transparent border round each sprite
const DEFAULT_HEIGHT_PX = 200; // her height on the HUD
const HEAD_FRAC = 0.15; // the default headY, this far down the figure
const WAIST_FRAC = 0.4; // the default waist, this far down the figure
const MARGIN_X_FRAC = 0.025; // the frame's margin either side (for the swaying tails), of the figure's height
const MARGIN_Y_FRAC = 0.006; // the frame's margin above and below, of the figure's height
const DEFAULT_PERSPECTIVE = { widen: 0.14, shorten: 0.1 }; // the fb lean's depth
const LEAN_EPS = 1e-6; // float slack when comparing lean fractions
const SHOULDER_BAND = 0.06; // an arm's shoulder: its vertices in this top fraction of its height
const HEAD_BAND = 0.04; // the head band, this fraction of the frame's height either side of headY
const SOLID_ALPHA = 128; // a pixel over this alpha is solid (the head's top row)
const HEAD_TOP_MIN = 3; // solid pixels a row needs to be the head's top
const ALPHA_EMPTY = 2; // a pixel at or under this alpha is transparent (alphaBox)
const PIXEL_DIFF_MIN = 6; // RGBA difference summed under this: the pixel did not change
const SHRINK_SLACK = 1.01; // halve while the half is still at least this much over the target
const DEFAULT_TAILS_ROOT = 0.15; // where the tails hang from, a fraction down their sprite
const ZOOM_STEPS_MAX = 3; // close-up zoom steps, also the default
const TURN_STEPS_DEFAULT = 2; // close-up turn steps each way by default
const TURN_STEPS_MAX = 17; // and at most: what a 2048x2048 close-up atlas holds with 3 zoom steps and 3 sway poses
const DEFAULT_SWAY = { ParamAngleZ: 4 }; // the close-up's sway at a full swing
const DEFAULT_TURN = { ParamAngleX: 30 }; // the close-up's head turn toward the right of the screen
const TURN_SEARCH_DEG = 8; // bestTurn tries -8 .. 8 deg
const TURN_SEARCH_STEP = 0.1; // deg
const INSPECT_H = 1000; // ?inspect: the figure's height in px
const GRID_PER_UNIT = 10; // ?inspect: grid lines per model unit
const GRID_STEP = 1 / GRID_PER_UNIT;
const GRID_LABEL_TOP = 12; // ?inspect: the x labels' baseline
const PART_THUMB = 128; // ?inspect: each part's own picture, px square

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + ": " + response.status);
  return response.json();
}

/** @returns {Promise<Loaded>} */
async function loadModel() {
  const modelJson = await json("/model.json");
  const moc = cubismCore.Moc.fromArrayBuffer(
    await (await fetch("/model/" + modelJson.FileReferences.Moc)).arrayBuffer(),
  );
  if (!moc)
    throw new Error("the .moc3 did not load (Cubism Core too old for it?)");
  const model = cubismCore.Model.fromMoc(moc);
  const imgs = await Promise.all(
    modelJson.FileReferences.Textures.map(
      (texturePath) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error("texture " + texturePath));
          i.src = "/model/" + encodeURI(texturePath);
        }),
    ),
  );
  const cdi = modelJson.FileReferences.DisplayInfo
    ? await json(
        "/model/" + encodeURI(modelJson.FileReferences.DisplayInfo),
      ).catch(() => null)
    : null;
  return { m3: modelJson, model, imgs, cdi };
}

/* ---------- renderer ---------- */
const VERTEX_SRC = `attribute vec2 a_pos; attribute vec2 a_uv;
uniform vec4 u_xf; varying vec2 v_uv;
void main() { gl_Position = vec4(a_pos * u_xf.xy + u_xf.zw, 0.0, 1.0); v_uv = vec2(a_uv.x, 1.0 - a_uv.y); }`;
const FRAGMENT_SRC = `precision mediump float;
uniform sampler2D u_tex; uniform float u_op; uniform vec4 u_mul; uniform vec4 u_scr; uniform float u_mask;
varying vec2 v_uv;
void main() {
    vec4 t = texture2D(u_tex, v_uv);
    if (u_mask > 0.5) { if (t.a < 0.5) discard; gl_FragColor = vec4(0.0); return; }
    vec3 rgb = t.rgb * u_mul.rgb;
    rgb = rgb + u_scr.rgb - rgb * u_scr.rgb;
    float a = t.a * u_op;
    gl_FragColor = vec4(rgb * a, a);
}`;

class Renderer {
  /** @param {Loaded} loaded */
  constructor(loaded) {
    this.L = loaded;
    this.canvas = document.createElement("canvas");
    const gl = (this.gl = this.canvas.getContext("webgl", {
      stencil: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      alpha: true,
      antialias: true,
    }));
    /**
     * @param {number} type
     * @param {string} src
     * @returns {WebGLShader}
     */
    const compileShader = (type, src) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = (this.prog = gl.createProgram());
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, VERTEX_SRC));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SRC));
    gl.linkProgram(program);
    gl.useProgram(program);
    this.loc = {
      pos: gl.getAttribLocation(program, "a_pos"),
      uv: gl.getAttribLocation(program, "a_uv"),
    };
    /** @type {Record<string, WebGLUniformLocation | null>} */
    this.u = {};
    ["u_xf", "u_tex", "u_op", "u_mul", "u_scr", "u_mask"].forEach(
      (uniformName) => {
        this.u[uniformName] = gl.getUniformLocation(program, uniformName);
      },
    );
    this.bufPos = gl.createBuffer();
    this.bufUv = gl.createBuffer();
    this.bufIdx = gl.createBuffer();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.tex = loaded.imgs.map((img) => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR_MIPMAP_LINEAR,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    });
  }

  /* Draw the model into a w x h canvas: box [x0, y0, x1, y1] in model units fills it (y up). opts.only(i) /
   * opts.skip(i): which drawables. */
  /**
   * @param {number} w
   * @param {number} h
   * @param {Box | number[]} box
   * @param {DrawOpts} [opts]
   * @returns {HTMLCanvasElement} its own canvas, redrawn on the next call
   */
  draw(w, h, box, opts) {
    const gl = this.gl,
      drawables = this.L.model.drawables,
      options = opts || {};
    this.canvas.width = w;
    this.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    const scaleX = 2 / (box[2] - box[0]),
      scaleY = 2 / (box[3] - box[1]);
    gl.uniform4f(
      this.u.u_xf,
      scaleX,
      scaleY,
      -1 - box[0] * scaleX,
      -1 - box[1] * scaleY,
    );
    gl.uniform1i(this.u.u_tex, 0);
    const renderOrders = this.L.model.getRenderOrders
      ? this.L.model.getRenderOrders()
      : drawables.renderOrders;
    const order = Array.from({ length: drawables.count }, (_, i) => i).sort(
      (a, b) => renderOrders[a] - renderOrders[b],
    );
    order.forEach((i) => {
      if (
        !cubismCore.Utils.hasIsVisibleBit(drawables.dynamicFlags[i]) ||
        drawables.opacities[i] <= MIN_OPACITY
      )
        return;
      if (options.only && !options.only(i)) return;
      if (options.skip && options.skip(i)) return;
      const masks = drawables.masks[i],
        maskCount = drawables.maskCounts[i];
      if (maskCount > 0) {
        gl.enable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.uniform1f(this.u.u_mask, 1);
        for (let k = 0; k < maskCount; k++) this._mesh(masks[k]);
        gl.uniform1f(this.u.u_mask, 0);
        gl.colorMask(true, true, true, true);
        const inv = cubismCore.Utils.hasIsInvertedMaskBit(
          drawables.constantFlags[i],
        );
        gl.stencilFunc(inv ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      }
      const flags = drawables.constantFlags[i];
      if (cubismCore.Utils.hasBlendAdditiveBit(flags))
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      else if (cubismCore.Utils.hasBlendMultiplicativeBit(flags))
        gl.blendFuncSeparate(
          gl.DST_COLOR,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ZERO,
          gl.ONE,
        );
      else
        gl.blendFuncSeparate(
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA,
        );
      gl.uniform1f(this.u.u_op, drawables.opacities[i]);
      const multiplyColors = drawables.multiplyColors,
        screenColors = drawables.screenColors;
      gl.uniform4f(
        this.u.u_mul,
        multiplyColors ? multiplyColors[i * 4] : 1,
        multiplyColors ? multiplyColors[i * 4 + 1] : 1,
        multiplyColors ? multiplyColors[i * 4 + 2] : 1,
        1,
      );
      gl.uniform4f(
        this.u.u_scr,
        screenColors ? screenColors[i * 4] : 0,
        screenColors ? screenColors[i * 4 + 1] : 0,
        screenColors ? screenColors[i * 4 + 2] : 0,
        0,
      );
      this._mesh(i);
      if (maskCount > 0) gl.disable(gl.STENCIL_TEST);
    });
    return this.canvas;
  }

  /**
   * Draws drawable i (its cut triangles when it has some).
   * @param {number} i
   */
  _mesh(i) {
    const gl = this.gl,
      drawables = this.L.model.drawables;
    const pos = drawables.vertexPositions[i];
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[drawables.textureIndices[i]]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufUv);
    gl.bufferData(gl.ARRAY_BUFFER, drawables.vertexUvs[i], gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.loc.uv);
    gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 0, 0);
    const cut = this.L.cut && this.L.cut.get(i);
    const idx = cut || drawables.indices[i];
    if (!idx.length) return;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    gl.drawElements(
      gl.TRIANGLES,
      cut
        ? cut.length
        : drawables.indexCounts
          ? drawables.indexCounts[i]
          : drawables.indices[i].length,
      gl.UNSIGNED_SHORT,
      0,
    );
  }
}

/* ---------- model helpers ---------- */
/**
 * Every parameter to its default, then these.
 * @param {Loaded} loaded
 * @param {Params} [values]
 */
function setParams(loaded, values) {
  const parameters = loaded.model.parameters;
  for (let i = 0; i < parameters.count; i++)
    parameters.values[i] = parameters.defaultValues[i];
  Object.keys(values || {}).forEach((id) => {
    const i = parameters.ids.indexOf(id);
    if (i < 0) {
      log('  (no parameter "' + id + '")');
      return;
    }
    parameters.values[i] = Math.max(
      parameters.minimumValues[i],
      Math.min(parameters.maximumValues[i], values[id]),
    );
  });
}
/**
 * The parameters these .exp3.json expressions set, blended in order.
 * @param {string[]} [names]
 * @returns {Promise<Params>}
 */
async function expressionParams(names) {
  /** @type {Params} */
  const out = {};
  for (const fileName of names || []) {
    const expression = await json("/model/" + encodeURI(fileName));
    (expression.Parameters || []).forEach((param) => {
      out[param.Id] =
        param.Blend === "Multiply"
          ? (out[param.Id] || 1) * param.Value
          : param.Blend === "Overwrite"
            ? param.Value
            : (out[param.Id] || 0) + param.Value;
    });
  }
  return out;
}
/* Is drawable i inside one of these parts (by id), at any depth? */
/**
 * @param {Loaded} loaded
 * @param {string[]} ids
 * @returns {DrawablePick}
 */
function inParts(loaded, ids) {
  const parts = loaded.model.parts,
    drawables = loaded.model.drawables,
    /** @type {Set<number>} */
    want = new Set();
  ids.forEach((id) => {
    const k = parts.ids.indexOf(id);
    if (k >= 0) want.add(k);
    else log('  (no part "' + id + '")');
  });
  /** @type {Map<number, boolean>} */
  const memo = new Map();
  return (i) => {
    if (memo.has(i)) return memo.get(i);
    let k = drawables.parentPartIndices[i],
      hit = false;
    while (k >= 0 && !hit) {
      hit = want.has(k);
      k = parts.parentIndices[k];
    }
    memo.set(i, hit);
    return hit;
  };
}
/**
 * The box round the visible drawables (only these, when given).
 * @param {Loaded} loaded
 * @param {DrawablePick} [only]
 * @returns {Box}
 */
function bounds(loaded, only) {
  const drawables = loaded.model.drawables;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < drawables.count; i++) {
    if (
      !cubismCore.Utils.hasIsVisibleBit(drawables.dynamicFlags[i]) ||
      drawables.opacities[i] <= MIN_OPACITY ||
      (only && !only(i))
    )
      continue;
    const positions = drawables.vertexPositions[i];
    for (let k = 0; k < positions.length; k += 2) {
      x0 = Math.min(x0, positions[k]);
      x1 = Math.max(x1, positions[k]);
      y0 = Math.min(y0, positions[k + 1]);
      y1 = Math.max(y1, positions[k + 1]);
    }
  }
  return [x0, y0, x1, y1];
}

/* ---------- inspect ---------- */
/**
 * ?inspect: the figure with a grid in model units, and each part alone.
 * @param {Loaded} loaded
 * @param {BakeConfig} cfg
 */
async function inspect(loaded, cfg) {
  setParams(loaded, cfg.params);
  loaded.model.update();
  const renderer = new Renderer(loaded),
    drawables = loaded.model.drawables,
    parts = loaded.model.parts;
  const box = bounds(loaded);
  log(
    "figure box (model units): x " +
      box[0].toFixed(3) +
      ".." +
      box[2].toFixed(3) +
      ", y " +
      box[1].toFixed(3) +
      ".." +
      box[3].toFixed(3) +
      " (y up)",
  );
  /** @type {Record<string, string>} part id to name */
  const names = {};
  ((loaded.cdi && loaded.cdi.Parts) || []).forEach((part) => {
    names[part.Id] = part.Name;
  });
  const H = INSPECT_H,
    W = Math.round((H * (box[2] - box[0])) / (box[3] - box[1]));
  const full = renderer.draw(W, H, box);
  const big = document.createElement("canvas");
  big.className = "big";
  big.width = W;
  big.height = H;
  const bigCtx = big.getContext("2d");
  bigCtx.drawImage(full, 0, 0);
  // a grid every 0.1 model units, labelled, to read positions off (the anchor between her feet, the waist, the face)
  bigCtx.strokeStyle = "rgba(255,80,80,.5)";
  bigCtx.fillStyle = "#f66";
  bigCtx.font = "11px monospace";
  for (
    let modelY = Math.ceil(box[1] * GRID_PER_UNIT) / GRID_PER_UNIT;
    modelY <= box[3];
    modelY += GRID_STEP
  ) {
    const y = H - ((modelY - box[1]) / (box[3] - box[1])) * H;
    bigCtx.beginPath();
    bigCtx.moveTo(0, y);
    bigCtx.lineTo(W, y);
    bigCtx.stroke();
    bigCtx.fillText(modelY.toFixed(1), 2, y - 2);
  }
  for (
    let modelX = Math.ceil(box[0] * GRID_PER_UNIT) / GRID_PER_UNIT;
    modelX <= box[2];
    modelX += GRID_STEP
  ) {
    const x = ((modelX - box[0]) / (box[2] - box[0])) * W;
    bigCtx.beginPath();
    bigCtx.moveTo(x, 0);
    bigCtx.lineTo(x, H);
    bigCtx.stroke();
    bigCtx.fillText(modelX.toFixed(1), x + 2, GRID_LABEL_TOP);
  }
  view.appendChild(big);
  // every part with drawables of its own, alone
  const grid = document.createElement("div");
  grid.className = "grid";
  view.appendChild(grid);
  for (let k = 0; k < parts.count; k++) {
    const only = inParts(loaded, [parts.ids[k]]);
    let any = false;
    for (let i = 0; i < drawables.count && !any; i++)
      any =
        only(i) &&
        cubismCore.Utils.hasIsVisibleBit(drawables.dynamicFlags[i]) &&
        drawables.opacities[i] > MIN_OPACITY;
    if (!any) continue;
    const cell = document.createElement("div");
    cell.className = "cell";
    const canvas = document.createElement("canvas");
    canvas.width = PART_THUMB;
    canvas.height = PART_THUMB;
    const img = renderer.draw(
      PART_THUMB,
      PART_THUMB,
      [box[0], box[1], box[0] + (box[3] - box[1]), box[3]],
      { only },
    );
    canvas.getContext("2d").drawImage(img, 0, 0);
    cell.appendChild(canvas);
    cell.appendChild(
      document.createTextNode(parts.ids[k] + " " + (names[parts.ids[k]] || "")),
    );
    grid.appendChild(cell);
  }
  log("parts shown: " + grid.children.length + " of " + parts.count);
}

/* ---------- bake ---------- */
// Scale a canvas down to w x h in halving steps (a single big step aliases)
/**
 * @param {HTMLCanvasElement} src
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
function shrink(src, w, h) {
  let current = src;
  while (current.width / 2 >= w * SHRINK_SLACK) {
    const half = document.createElement("canvas");
    half.width = Math.round(current.width / 2);
    half.height = Math.round(current.height / 2);
    const ctx = half.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(current, 0, 0, w, h);
  return out;
}
/**
 * The rect of the canvas's pixels that are not transparent; null when none.
 * @param {HTMLCanvasElement} canvas
 * @returns {Rect | null}
 */
function alphaBox(canvas) {
  const pixels = canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height).data;
  let x0 = canvas.width,
    y0 = canvas.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < canvas.height; y++)
    for (let x = 0; x < canvas.width; x++)
      if (pixels[(y * canvas.width + x) * 4 + 3] > ALPHA_EMPTY) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/* "cut": { drawable id: model y }: drop that drawable's triangles lying wholly below the y, measured once in the idle pose
 * and dropped by index from then on (so they stay dropped as she moves): for a drawable that carries something you may
 * leave out inside a mesh you need, e.g. text built into a face mesh. */
/**
 * @param {Loaded} loaded
 * @param {Record<string, number> | undefined} cut
 * @param {Params} params the idle pose
 */
function makeCuts(loaded, cut, params) {
  loaded.cut = new Map();
  if (!cut) return;
  setParams(loaded, params);
  loaded.model.update();
  const drawables = loaded.model.drawables;
  Object.keys(cut).forEach((id) => {
    const i = drawables.ids.indexOf(id);
    if (i < 0) {
      log('  (no drawable "' + id + '")');
      return;
    }
    const positions = drawables.vertexPositions[i],
      indices = drawables.indices[i],
      indexCount = drawables.indexCounts
        ? drawables.indexCounts[i]
        : indices.length,
      /** @type {number[]} */
      keep = [];
    for (let k = 0; k < indexCount; k += 3) {
      const below = [indices[k], indices[k + 1], indices[k + 2]].every(
        (vertex) => positions[2 * vertex + 1] < cut[id],
      );
      if (!below) keep.push(indices[k], indices[k + 1], indices[k + 2]);
    }
    loaded.cut.set(i, new Uint16Array(keep));
    log(
      "  cut " +
        id +
        ": " +
        (indexCount - keep.length) / 3 +
        " of " +
        indexCount / 3 +
        " triangles",
    );
  });
}

/* ---------- the close-up ---------- */
/**
 * The close-up's own atlas (close.rgba): what the HUD zooms into when the car stops. Every frame is the window's
 * size and drawn at that size, so nothing is scaled up on the HUD:
 *   slots 0 .. zoomSteps - 1   the zoom on its way in: the camera at k / (zoomSteps + 1) of the way from the window
 *                              (standing) to the close-up, the toggles at the same fraction
 *   then the close-up's poses  sway left, middle, sway right, then turn -2, -1, 1, 2 (turn "steps" each way)
 *   then the crops             each pose's eyes half shut and shut, one rect (frame px) for all of them
 * Frames are laid out on a grid the HUD computes from a few numbers (atlas.json close.grid), so it needs no tables.
 * @param {Loaded} loaded
 * @param {BakeConfig} cfg
 * @param {{ renderer: Renderer, hidden: DrawablePick, ppu: number, box: Box, feet: number[] }} at the standing bake:
 *   its px per model unit, frame box (model units) and the model point that goes on the widget's "feet"
 * @returns {Promise<{ canvas: HTMLCanvasElement, info: Record<string, *> } | null>}
 */
async function bakeClose(loaded, cfg, at) {
  const close = cfg.close;
  if (!close || !Array.isArray(close.size) || !Array.isArray(close.window))
    return null;
  const pad = cfg.pad || DEFAULT_PAD,
    [frameW, frameH] = close.size,
    aspect = frameW / frameH,
    ppu = at.ppu,
    parameters = loaded.model.parameters;
  // the two framings, model boxes [x0, y0, x1, y1] (y up): the HUD window round her standing (close.window: x, y,
  // w, h in HUD px from her feet), and the close-up (close.centre, close.height in model units)
  const win = close.window,
    box0 = [
      at.feet[0] + win[0] / ppu,
      at.feet[1] - (win[1] + win[3]) / ppu,
      at.feet[0] + (win[0] + win[2]) / ppu,
      at.feet[1] - win[1] / ppu,
    ],
    h1 = close.height,
    box1 = [
      close.centre[0] - (h1 * aspect) / 2,
      close.centre[1] - h1 / 2,
      close.centre[0] + (h1 * aspect) / 2,
      close.centre[1] + h1 / 2,
    ];
  const h0 = box0[3] - box0[1],
    c0 = [(box0[0] + box0[2]) / 2, (box0[1] + box0[3]) / 2],
    c1 = [(box1[0] + box1[2]) / 2, (box1[1] + box1[3]) / 2];
  /**
   * The camera at u (0 the window, 1 the close-up): the height eases geometrically (an even zoom) and the centre
   * moves as the height does, so it zooms toward a point. Model box.
   * @param {number} u
   * @returns {Box}
   */
  const camera = (u) => {
    const h = h0 * Math.pow(h1 / h0, u),
      w = h * aspect,
      along = (h0 - h) / (h0 - h1),
      cx = c0[0] + (c1[0] - c0[0]) * along,
      cy = c0[1] + (c1[1] - c0[1]) * along;
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  };
  /**
   * A model box in the standing frame's px: [x, y, w, h] (y down), what the HUD's shader works in.
   * @param {Box} b
   * @returns {number[]}
   */
  const inFrame = (b) =>
    [
      (b[0] - at.box[0]) * ppu,
      (at.box[3] - b[3]) * ppu,
      (b[2] - b[0]) * ppu,
      (b[3] - b[1]) * ppu,
    ].map((v) => Math.round(v * 100) / 100);
  // the toggles (expressions and params) blend from the model's defaults at the zoom's start to fully on at its end
  const full = Object.assign(
    {},
    await expressionParams(close.expressions),
    close.params || {},
  );
  /**
   * The toggles at fraction t.
   * @param {number} t
   * @returns {Params}
   */
  const toggles = (t) => {
    /** @type {Params} */
    const out = {};
    Object.keys(full).forEach((id) => {
      const i = parameters.ids.indexOf(id),
        def = i >= 0 ? parameters.defaultValues[i] : 0;
      out[id] = def + (full[id] - def) * t;
    });
    return out;
  };
  const idle = (cfg.frames && cfg.frames.idle && cfg.frames.idle.params) || {},
    half = (cfg.frames.half && cfg.frames.half.params) || {},
    shut = (cfg.frames.shut && cfg.frames.shut.params) || {};
  /** @type {DrawOpts} */
  const opts = { skip: at.hidden };
  /**
   * The model with these params, drawn through camera box b at the frame's size.
   * @param {Params} params
   * @param {Box} b
   * @returns {HTMLCanvasElement}
   */
  const shot = (params, b) => {
    setParams(loaded, Object.assign({}, cfg.params, idle, params));
    loaded.model.update();
    return shrink(
      at.renderer.draw(frameW * SUPERSAMPLE, frameH * SUPERSAMPLE, b, opts),
      frameW,
      frameH,
    );
  };
  const zoomSteps = Math.max(
    1,
    Math.min(ZOOM_STEPS_MAX, Math.round(close.zoomSteps || ZOOM_STEPS_MAX)),
  );
  /** @type {HTMLCanvasElement[]} */
  const full_ = [];
  /** @type {number[][]} */
  const rects = [];
  for (let k = 1; k <= zoomSteps; k++) {
    const u = k / (zoomSteps + 1);
    full_.push(shot(toggles(u), camera(u)));
    rects.push(inFrame(camera(u)));
  }
  rects.push(inFrame(box1));
  // the close-up's poses: sway (close.sway at -1, 0, 1) and the turn (close.turn at -1 .. 1 in turnSteps each way)
  const sway = close.sway || DEFAULT_SWAY,
    turn = close.turn || DEFAULT_TURN,
    turnSteps = Math.max(
      1,
      Math.min(TURN_STEPS_MAX, Math.round(close.turnSteps || TURN_STEPS_DEFAULT)),
    );
  /**
   * params scaled by k.
   * @param {Params} params
   * @param {number} k
   * @returns {Params}
   */
  const times = (params, k) =>
    Object.fromEntries(Object.keys(params).map((id) => [id, params[id] * k]));
  /** @type {Params[]} */
  const poses = [times(sway, -1), {}, times(sway, 1)];
  if (close.turnPoses && close.turnPoses.length !== 2 * turnSteps)
    throw new Error("close.turnPoses: " + close.turnPoses.length + " poses, turnSteps " + turnSteps + " needs " + 2 * turnSteps);
  for (let k = -turnSteps; k <= turnSteps; k++)
    if (k)
      poses.push(
        close.turnPoses ? close.turnPoses[k < 0 ? k + turnSteps : k + turnSteps - 1] : times(turn, k / turnSteps),
      );
  /** @type {HTMLCanvasElement[][]} */
  const posed = poses.map((pose) => {
    const base = Object.assign(toggles(1), pose);
    return [
      shot(base, box1),
      shot(Object.assign({}, base, half), box1),
      shot(Object.assign({}, base, shut), box1),
    ];
  });
  /**
   * A frame's pixels.
   * @param {HTMLCanvasElement} canvas
   * @returns {Uint8ClampedArray}
   */
  const px = (canvas) =>
    canvas.getContext("2d").getImageData(0, 0, frameW, frameH).data;
  // the eyes: one rect round every pixel any half or shut frame changes from its pose's open one, plus a margin
  let x0 = frameW,
    y0 = frameH,
    x1 = -1,
    y1 = -1;
  posed.forEach(([open, ...eyes]) => {
    const base = px(open);
    eyes.forEach((canvas) => {
      const pixels = px(canvas);
      for (let k = 0; k < pixels.length; k += 4) {
        let diff = 0;
        for (let c = 0; c < 4; c++)
          diff += Math.abs(pixels[k + c] - base[k + c]);
        if (diff < PIXEL_DIFF_MIN) continue;
        const x = (k / 4) % frameW,
          y = (k / 4 - x) / frameW;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    });
  });
  if (x1 < 0)
    throw new Error(
      "close-up: the eyes don't change with frames.half or frames.shut",
    );
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(frameW - 1, x1 + 1);
  y1 = Math.min(frameH - 1, y1 + 1);
  const crop = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  // the shader's alignment while it blends: the sway's turn on screen (rad, clockwise; measured from how far the top
  // of her head moves about close.pivot), and each turn frame's head shift (px, the alpha centroid across her eyes)
  const pivot = [
    (close.pivot[0] - box1[0]) * (frameW / (box1[2] - box1[0])),
    (box1[3] - close.pivot[1]) * (frameH / (box1[3] - box1[1])),
  ];
  /**
   * The alpha centroid x of rows y0 .. y1 of a frame.
   * @param {HTMLCanvasElement} canvas
   * @param {number} top
   * @param {number} bottom
   * @returns {number}
   */
  const midX = (canvas, top, bottom) => {
    const pixels = px(canvas);
    let sum = 0,
      weight = 0;
    for (
      let y = Math.max(0, Math.round(top));
      y < Math.min(frameH, Math.round(bottom));
      y++
    )
      for (let x = 0; x < frameW; x++) {
        const a = pixels[(y * frameW + x) * 4 + 3];
        sum += x * a;
        weight += a;
      }
    return weight ? sum / weight : frameW / 2;
  };
  // the sway's turn: the rotation about the pivot that best lays her middle pose over each sway pose, above the pivot
  /**
   * The angle (rad, clockwise on screen) that best turns frame "from" onto frame "to" about the pivot.
   * @param {HTMLCanvasElement} from
   * @param {HTMLCanvasElement} to
   * @returns {number}
   */
  const bestTurn = (from, to) => {
    const target = px(to),
      turned = document.createElement("canvas");
    turned.width = frameW;
    turned.height = frameH;
    const tctx = turned.getContext("2d");
    let best = 0,
      bestErr = Infinity;
    for (
      let deg = -TURN_SEARCH_DEG;
      deg <= TURN_SEARCH_DEG + 0.001;
      deg += TURN_SEARCH_STEP
    ) {
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, frameW, frameH);
      tctx.translate(pivot[0], pivot[1]);
      tctx.rotate((deg * Math.PI) / 180);
      tctx.translate(-pivot[0], -pivot[1]);
      tctx.drawImage(from, 0, 0);
      const pixels = tctx.getImageData(0, 0, frameW, frameH).data;
      let err = 0;
      for (let y = 0; y < Math.min(frameH, pivot[1]); y += 2)
        for (let x = 0; x < frameW; x += 2) {
          const k = (y * frameW + x) * 4;
          for (let c = 0; c < 4; c++)
            err += Math.abs(pixels[k + c] - target[k + c]);
        }
      if (err < bestErr) {
        bestErr = err;
        best = (deg * Math.PI) / 180;
      }
    }
    return Math.round(best * 10000) / 10000;
  };
  const swayAngle = [0, 2].map((i) => bestTurn(posed[1][0], posed[i][0]));
  const eyeMid = midX(posed[1][0], y0, y1 + 1);
  const turnShift = posed
    .slice(3)
    .map(
      (frames) => Math.round((midX(frames[0], y0, y1 + 1) - eyeMid) * 10) / 10,
    );
  log(
    "close-up " +
      frameW +
      "x" +
      frameH +
      ": " +
      zoomSteps +
      " zoom steps, " +
      poses.length +
      " poses, eyes cropped to " +
      crop[2] +
      "x" +
      crop[3] +
      "; sway " +
      swayAngle.map((a) => ((a * 180) / Math.PI).toFixed(1)).join(" / ") +
      " deg, turn head shifts " +
      turnShift.join(", ") +
      " px",
  );
  // the grid: whole frames first, then the crops
  const MAX = turnSteps > TURN_STEPS_DEFAULT ? CLOSE_ATLAS_MAX : ATLAS_MAX,
    cell = [frameW + 2 * pad, frameH + 2 * pad],
    cols = Math.floor(MAX / cell[0]),
    wholes = full_.concat(posed.map((frames) => frames[0])),
    rows = Math.ceil(wholes.length / cols),
    cropCell = [crop[2] + 2 * pad, crop[3] + 2 * pad],
    cropCols = Math.floor(MAX / cropCell[0]),
    crops = [];
  posed.forEach((frames) => crops.push(frames[1], frames[2]));
  const cropY = rows * cell[1],
    atlasH = ceilBlock(cropY + Math.ceil(crops.length / cropCols) * cropCell[1]);
  if (atlasH > MAX)
    throw new Error(
      "the close-up atlas would be " +
        atlasH +
        " px high: over " +
        MAX +
        ", which restarts the instrument cluster. Bake a smaller close.size, fewer close.zoomSteps or close.turnSteps",
    );
  const atlas = document.createElement("canvas");
  atlas.width = MAX;
  atlas.height = atlasH;
  const ctx = atlas.getContext("2d");
  wholes.forEach((canvas, n) =>
    ctx.drawImage(
      canvas,
      (n % cols) * cell[0] + pad,
      Math.floor(n / cols) * cell[1] + pad,
    ),
  );
  crops.forEach((canvas, n) =>
    ctx.drawImage(
      canvas,
      crop[0],
      crop[1],
      crop[2],
      crop[3],
      (n % cropCols) * cropCell[0] + pad,
      cropY + Math.floor(n / cropCols) * cropCell[1] + pad,
      crop[2],
      crop[3],
    ),
  );
  return {
    canvas: atlas,
    info: {
      atlas: [MAX, atlasH],
      frame: [frameW, frameH],
      zoomSteps,
      turnSteps,
      // grid: cell w, h, columns, pad; cropGrid: cell w, h, columns, y of the first row
      grid: [cell[0], cell[1], cols, pad],
      cropGrid: [cropCell[0], cropCell[1], cropCols, cropY],
      crop,
      // each zoom step's camera and the close-up's, [x, y, w, h] in the standing frame's px
      rects,
      pivot: pivot.map((v) => Math.round(v * 10) / 10),
      swayAngle,
      turnShift,
    },
  };
}

/**
 * Bakes the frames and sprites into the atlas and posts atlas.rgba, atlas.json and preview.png to serve.js.
 * @param {Loaded} loaded
 * @param {BakeConfig} cfg
 */
async function bake(loaded, cfg) {
  const pad = cfg.pad || DEFAULT_PAD;
  /** @type {DrawablePick} */
  const hidden =
    cfg.hide && cfg.hide.length ? inParts(loaded, cfg.hide) : () => false;
  const tailsIn =
    cfg.tails && cfg.tails.length ? inParts(loaded, cfg.tails) : null;
  /** @type {DrawablePick | null} */
  const tails = tailsIn ? (i) => tailsIn(i) && !hidden(i) : null;
  // arms: each its own sprite, which the HUD turns from the shoulder (to point at the indicator); left out of every
  // body frame. The bake measures where each shoulder sits and how the arm turns at a full lean each way
  const armsIn = (cfg.arms || []).map((arm) =>
    inParts(loaded, arm.parts || []),
  );
  /** @type {DrawablePick} */
  const isArm = (i) => armsIn.some((inArm) => inArm(i));
  const renderer = new Renderer(loaded);
  const idle = (cfg.frames && cfg.frames.idle && cfg.frames.idle.params) || {};
  makeCuts(loaded, cfg.cut, Object.assign({}, cfg.params, idle));
  // one box for every frame and sprite: the whole figure at idle, with a margin for the swaying tails
  setParams(loaded, Object.assign({}, cfg.params, idle));
  loaded.model.update();
  let box = bounds(loaded, (i) => !hidden(i));
  // her size: pxPerUnit, else heightPx (200) over the figure's height; landmarks default to fractions of the figure,
  // so a model in any units bakes without them
  const figH = box[3] - box[1];
  const centreX = (box[0] + box[2]) / 2;
  const ppu = cfg.pxPerUnit || (cfg.heightPx || DEFAULT_HEIGHT_PX) / figH;
  const headY = isFinite(cfg.headY) ? cfg.headY : box[3] - HEAD_FRAC * figH;
  const waist = isFinite(cfg.waist) ? cfg.waist : box[3] - WAIST_FRAC * figH;
  const margin = MARGIN_X_FRAC * figH;
  box = [
    box[0] - margin,
    box[1] - MARGIN_Y_FRAC * figH,
    box[2] + margin,
    box[3] + MARGIN_Y_FRAC * figH,
  ];
  const frameW = Math.ceil((box[2] - box[0]) * ppu),
    frameH = Math.ceil((box[3] - box[1]) * ppu);
  /**
   * A model point in frame px.
   * @param {number} x
   * @param {number} y
   * @returns {[number, number]}
   */
  const toFrame = (x, y) => [(x - box[0]) * ppu, (box[3] - y) * ppu];
  log("frame " + frameW + "x" + frameH + " px");
  /**
   * @param {DrawOpts} opts
   * @returns {HTMLCanvasElement} a new fw x fh frame
   */
  const render = (opts) =>
    shrink(
      renderer.draw(frameW * SUPERSAMPLE, frameH * SUPERSAMPLE, box, opts),
      frameW,
      frameH,
    );
  // the forward/back lean in perspective: above the waist she tips out of the screen, so her upper body gets shorter
  // (by "shorten" at a full lean) and its top narrower leaning back (a full lean right), wider toward you (by "widen"); her legs stay as they are.
  // Baked into the frames, so the HUD's shader does nothing more. persp(a, x, y) moves a frame px point the same way
  const fbLean = cfg.lean && cfg.lean.axis === "fb";
  const perspective = fbLean
    ? Object.assign({}, DEFAULT_PERSPECTIVE, cfg.lean.perspective || {})
    : null;
  const waistPx = toFrame(0, waist)[1],
    cxPx = toFrame(centreX, 0)[0];
  /**
   * @param {number} lean the lean, -1 .. 1
   * @param {number} x
   * @param {number} y
   * @returns {number[]}
   */
  const persp = (lean, x, y) => {
    if (!perspective || y >= waistPx) return [x, y];
    const above = (waistPx - y) * (1 - perspective.shorten * Math.abs(lean)),
      aboveFrac = above / waistPx;
    return [
      cxPx + (x - cxPx) * (1 - perspective.widen * lean * aboveFrac),
      waistPx - above,
    ];
  };
  // the same on a render at SS times the size, row by row: each row above the waist comes from the row it was before
  // the shortening, scaled about her middle
  /**
   * @param {DrawOpts} opts
   * @param {number} lean the lean, -1 .. 1
   * @returns {HTMLCanvasElement}
   */
  const renderLean = (opts, lean) => {
    const big = renderer.draw(
      frameW * SUPERSAMPLE,
      frameH * SUPERSAMPLE,
      box,
      opts,
    );
    if (!perspective) return shrink(big, frameW, frameH);
    const W = frameW * SUPERSAMPLE,
      H = frameH * SUPERSAMPLE,
      waistY = waistPx * SUPERSAMPLE,
      cx = cxPx * SUPERSAMPLE,
      k = 1 - perspective.shorten * Math.abs(lean);
    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      big,
      0,
      Math.floor(waistY),
      W,
      H - Math.floor(waistY),
      0,
      Math.floor(waistY),
      W,
      H - Math.floor(waistY),
    );
    for (let y = 0; y < Math.floor(waistY); y++) {
      const above = waistY - y - 0.5,
        src = waistY - above / k;
      if (src < 0) continue;
      const scaleX = 1 - perspective.widen * lean * (above / waistY);
      ctx.drawImage(big, 0, src, W, 1, cx - cx * scaleX, y, W * scaleX, 1);
    }
    return shrink(out, frameW, frameH);
  };
  /** @type {DrawOpts} */
  const body = {
    skip: (i) => hidden(i) || (tails ? tails(i) : false) || isArm(i),
  };
  const names = ["idle", "half", "shut", "talk"],
    /** @type {Record<string, HTMLCanvasElement>} */
    frames = {};
  for (const name of names) {
    const frameCfg = (cfg.frames && cfg.frames[name]) || {};
    const exprParams = await expressionParams(frameCfg.expressions);
    setParams(
      loaded,
      Object.assign({}, cfg.params, exprParams, frameCfg.params || {}),
    );
    loaded.model.update();
    frames[name] = render(body);
  }
  // the lean angles, left to right; the middle one is upright (idle itself, not baked again)
  const leanSteps = (cfg.lean && cfg.lean.steps) || DEFAULT_LEAN_STEPS,
    leanParams = (cfg.lean && cfg.lean.params) || {},
    faceAt = (cfg.lean && cfg.lean.face) || DEFAULT_LEAN_FACE;
  const leanPoses = cfg.lean && cfg.lean.poses;
  if (leanPoses && leanPoses.length !== leanSteps - 1)
    throw new Error("lean.poses: " + leanPoses.length + " poses, " + leanSteps + " steps need " + (leanSteps - 1));
  /**
   * Angle k's lean params: its own pose, or "params" times its lean.
   * @param {number} k
   * @param {number} lean
   * @returns {Params}
   */
  const leanPose = (k, lean) =>
    leanPoses
      ? Object.assign({}, leanPoses[k < (leanSteps - 1) / 2 ? k : k - 1])
      : Object.fromEntries(Object.keys(leanParams).map((id) => [id, leanParams[id] * lean]));
  /** @type {string[]} */
  const leanNames = [];
  for (let k = 0; k < leanSteps; k++) {
    const lean = -1 + (2 * k) / (leanSteps - 1);
    if (Math.abs(lean) < LEAN_EPS) {
      leanNames.push("idle");
      continue;
    }
    const poseParams = leanPose(k, lean);
    if (lean <= -faceAt + LEAN_EPS)
      Object.assign(poseParams, (cfg.lean && cfg.lean.left) || {});
    if (lean >= faceAt - LEAN_EPS)
      Object.assign(poseParams, (cfg.lean && cfg.lean.right) || {});
    setParams(loaded, Object.assign({}, cfg.params, idle, poseParams));
    loaded.model.update();
    const name = "lean" + k;
    frames[name] = renderLean(body, lean);
    names.push(name);
    leanNames.push(name);
  }
  // each arm: its shoulder (the middle of its topmost vertices) and its middle, in frame px, at rest and at a full lean
  // each way (the lean's own arm sway included), so the HUD can carry the sprite with her and turn it as she turns it
  /**
   * @param {DrawablePick} inArm the arm's drawables
   * @returns {ArmPose | null} null when none is visible
   */
  const armAt = (inArm) => {
    const drawables = loaded.model.drawables;
    let top = -Infinity,
      bot = Infinity,
      sumX = 0,
      sumY = 0,
      count = 0;
    /** @param {(positions: Float32Array) => void} fn called with each visible drawable's vertex positions */
    const each = (fn) => {
      for (let i = 0; i < drawables.count; i++) {
        if (
          !inArm(i) ||
          hidden(i) ||
          !cubismCore.Utils.hasIsVisibleBit(drawables.dynamicFlags[i])
        )
          continue;
        fn(drawables.vertexPositions[i]);
      }
    };
    each((positions) => {
      for (let k = 0; k < positions.length; k += 2) {
        top = Math.max(top, positions[k + 1]);
        bot = Math.min(bot, positions[k + 1]);
        sumX += positions[k];
        sumY += positions[k + 1];
        count++;
      }
    });
    if (!count) return null;
    const band = top - (top - bot) * SHOULDER_BAND;
    let bandSumX = 0,
      bandCount = 0;
    each((positions) => {
      for (let k = 0; k < positions.length; k += 2)
        if (positions[k + 1] >= band) {
          bandSumX += positions[k];
          bandCount++;
        }
    });
    const shoulder = toFrame(bandSumX / bandCount, top),
      middle = toFrame(sumX / count, sumY / count);
    return {
      P: shoulder,
      ang: Math.atan2(middle[1] - shoulder[1], middle[0] - shoulder[0]),
    };
  };
  /** @type {{ rest?: ArmPose | null, left?: ArmPose | null, right?: ArmPose | null }[]} */
  const armPose = armsIn.map(() => ({}));
  if (armsIn.length) {
    [
      [0, "left"],
      [leanSteps - 1, "right"],
    ].forEach(([k, side]) => {
      const lean = -1 + (2 * k) / (leanSteps - 1),
        poseParams = leanPose(k, lean);
      setParams(loaded, Object.assign({}, cfg.params, idle, poseParams));
      loaded.model.update();
      armsIn.forEach((inArm, j) => {
        const pose = armAt(inArm);
        if (pose) pose.P = persp(lean, pose.P[0], pose.P[1]); // the shoulder where the perspective puts it
        armPose[j][side] = pose;
      });
    });
  }
  setParams(loaded, Object.assign({}, cfg.params, idle));
  loaded.model.update();
  /** @type {{ j: number, cv: HTMLCanvasElement, bb: Rect, pose: (typeof armPose)[number] }[]} */
  const arms = [];
  armsIn.forEach((inArm, j) => {
    armPose[j].rest = armAt(inArm);
    const canvas = render({ only: (i) => inArm(i) && !hidden(i) }),
      rect = alphaBox(canvas);
    if (rect && armPose[j].rest)
      arms.push({ j, cv: canvas, bb: rect, pose: armPose[j] });
  });
  /** @type {{ cv: HTMLCanvasElement, bb: Rect } | null} */
  let tailsSprite = null;
  if (tails) {
    const canvas = render({ only: tails }),
      rect = alphaBox(canvas);
    if (rect) tailsSprite = { cv: canvas, bb: rect };
  }
  // the face frames differ from idle only around her head: each keeps just one crop, the same rect
  // for all of them (where any of them differs from idle, plus a margin), and the HUD draws idle round it
  const cropped = names.filter(
    (name) => name !== "idle" && name.indexOf("lean") !== 0,
  );
  /** @type {Rect | null} */
  let crop = null;
  if (cropped.length) {
    const base = frames.idle
      .getContext("2d")
      .getImageData(0, 0, frameW, frameH).data;
    let x0 = frameW,
      y0 = frameH,
      x1 = -1,
      y1 = -1;
    cropped.forEach((name) => {
      const pixels = frames[name]
        .getContext("2d")
        .getImageData(0, 0, frameW, frameH).data;
      for (let k = 0; k < pixels.length; k += 4) {
        if (
          Math.abs(pixels[k] - base[k]) +
            Math.abs(pixels[k + 1] - base[k + 1]) +
            Math.abs(pixels[k + 2] - base[k + 2]) +
            Math.abs(pixels[k + 3] - base[k + 3]) <
          PIXEL_DIFF_MIN
        )
          continue;
        const pixel = k / 4,
          x = pixel % frameW,
          y = (pixel - x) / frameW;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    });
    if (x1 >= 0) {
      const cropMargin = 4;
      x0 = Math.max(0, x0 - cropMargin);
      y0 = Math.max(0, y0 - cropMargin);
      x1 = Math.min(frameW - 1, x1 + cropMargin);
      y1 = Math.min(frameH - 1, y1 + cropMargin);
      crop = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
      log(
        "face frames cropped to " +
          crop[2] +
          "x" +
          crop[3] +
          " at " +
          crop[0] +
          "," +
          crop[1],
      );
    }
  }
  // pack everything into the atlas, at most ATLAS_MAX px a side
  /** @type {AtlasItem[]} */
  const items = names.map((name) => ({
    n: name,
    cv: frames[name],
    bb: crop && cropped.includes(name) ? crop : [0, 0, frameW, frameH],
  }));
  if (tailsSprite)
    items.push({ n: "tails", cv: tailsSprite.cv, bb: tailsSprite.bb });
  arms.forEach((arm) =>
    items.push({ n: "arm" + arm.j, cv: arm.cv, bb: arm.bb }),
  );
  // a skyline: tallest first, each where its top lands lowest (then leftmost)
  const MAX = ATLAS_MAX,
    sky = new Array(MAX).fill(0);
  items
    .slice()
    .sort((a, b) => b.bb[3] - a.bb[3] || b.bb[2] - a.bb[2])
    .forEach((item) => {
      const w = item.bb[2] + 2 * pad,
        h = item.bb[3] + 2 * pad;
      let bestX = -1,
        bestY = Infinity;
      for (let x = 0; x + w <= MAX; x++) {
        let y = 0;
        for (let k = x; k < x + w; k++) if (sky[k] > y) y = sky[k];
        if (y < bestY) {
          bestY = y;
          bestX = x;
        }
      }
      if (bestX < 0)
        throw new Error(
          "a sprite " + w + " px wide does not fit in " + MAX + " px",
        );
      for (let k = bestX; k < bestX + w; k++) sky[k] = bestY + h;
      item.at = [bestX + pad, bestY + pad];
    });
  let atlasW = ATLAS_MIN_W;
  while (
    atlasW <
    Math.max.apply(
      null,
      items.map((item) => item.at[0] + item.bb[2] + pad),
    )
  )
    atlasW *= 2;
  const atlasH = ceilBlock(
    Math.max.apply(
      null,
      items.map((item) => item.at[1] + item.bb[3] + pad),
    ),
  );
  if (atlasW > MAX || atlasH > MAX)
    throw new Error(
      "the atlas would be " +
        atlasW +
        "x" +
        atlasH +
        ": over " +
        MAX +
        " px a side, which restarts the instrument cluster. Bake fewer or smaller frames (heightPx, lean.steps)",
    );
  const atlas = document.createElement("canvas");
  atlas.width = atlasW;
  atlas.height = atlasH;
  const atlasCtx = atlas.getContext("2d");
  items.forEach((item) =>
    atlasCtx.drawImage(
      item.cv,
      item.bb[0],
      item.bb[1],
      item.bb[2],
      item.bb[3],
      item.at[0],
      item.at[1],
      item.bb[2],
      item.bb[3],
    ),
  );
  /** @type {Record<string, AtlasItem>} */
  const byN = {};
  items.forEach((item) => {
    byN[item.n] = item;
  });
  // where her head is in each lean frame (the alpha centroid of a band across the head), so the HUD can slide the
  // two nearest lean angles onto each other while it blends them instead of fading one through the other
  const headMid = Math.round(toFrame(0, headY)[1]);
  const bandY0 = Math.max(0, headMid - Math.round(frameH * HEAD_BAND)),
    bandY1 = Math.min(frameH, headMid + Math.round(frameH * HEAD_BAND));
  /**
   * The x of her head in a frame: the alpha centroid of the band at headY.
   * @param {HTMLCanvasElement} canvas
   * @returns {number}
   */
  const headX = (canvas) => {
    const pixels = canvas
      .getContext("2d")
      .getImageData(0, bandY0, frameW, bandY1 - bandY0).data;
    let sumX = 0,
      sumAlpha = 0;
    for (let k = 0; k < pixels.length; k += 4) {
      const alpha = pixels[k + 3];
      sumX += ((k / 4) % frameW) * alpha;
      sumAlpha += alpha;
    }
    return sumAlpha ? sumX / sumAlpha : frameW / 2;
  };
  const idleHeadX = headX(frames.idle);
  const shift = leanNames.map(
    (name) => Math.round((headX(frames[name]) - idleHeadX) * 10) / 10,
  );
  log("head shift per lean angle (px): " + shift.join(", "));
  // the forward/back lean moves her head up and down more than sideways: the tails follow that too. The top row of
  // her head (the first with a few solid pixels) against idle's
  /**
   * The top row of her head in a frame.
   * @param {HTMLCanvasElement} canvas
   * @returns {number}
   */
  const headTop = (canvas) => {
    const pixels = canvas
      .getContext("2d")
      .getImageData(0, 0, frameW, frameH).data;
    for (let y = 0; y < frameH; y++) {
      let solid = 0;
      for (let x = 0; x < frameW; x++)
        if (pixels[(y * frameW + x) * 4 + 3] > SOLID_ALPHA) solid++;
      if (solid >= HEAD_TOP_MIN) return y;
    }
    return 0;
  };
  const top0 = headTop(frames.idle);
  const shiftY = fbLean
    ? leanNames.map((name) => headTop(frames[name]) - top0)
    : null;
  if (fbLean) log("head drop per lean angle (px): " + shiftY.join(", "));
  const anchorModel = cfg.anchor || [
      (box[0] + box[2]) / 2,
      box[1] + MARGIN_Y_FRAC * figH,
    ],
    anchorOffset = cfg.anchorPx || [0, 0],
    anchor = toFrame(anchorModel[0], anchorModel[1]);
  /** @type {AtlasInfo} */
  const info = {
    version: 1,
    atlas: [atlasW, atlasH],
    frame: [frameW, frameH],
    frames: Object.fromEntries(names.map((name) => [name, byN[name].at])),
    lean: leanNames.map((name) => byN[name].at),
    anchor: [
      Math.round(anchor[0] - anchorOffset[0]),
      Math.round(anchor[1] - anchorOffset[1]),
    ],
    hipY: Math.round(toFrame(0, waist)[1]),
    headY: Math.round((bandY0 + bandY1) / 2),
    leanShift: shift,
  };
  // the face frames are crops of this rect (frame px); their positions are the crops' top-lefts
  if (fbLean) {
    info.leanAxis = "fb";
    info.leanShiftY = shiftY;
  }
  if (crop) info.crop = crop;
  if (tailsSprite) {
    const tailsItem = byN.tails,
      root = cfg.tailsRoot || DEFAULT_TAILS_ROOT;
    info.tails = {
      rect: [
        tailsItem.at[0],
        tailsItem.at[1],
        tailsItem.bb[2],
        tailsItem.bb[3],
      ],
      at: [tailsItem.bb[0], tailsItem.bb[1]],
      rootY: Math.round(tailsItem.bb[3] * root),
      length: Math.round(tailsItem.bb[3] * (1 - root)),
    };
  }
  if (arms.length) {
    const cx = toFrame(centreX, 0)[0],
      /**
       * Rounded to 0.1.
       * @param {number} x
       * @returns {number}
       */
      round1 = (x) => Math.round(x * 10) / 10;
    info.arms = arms.map((arm) => {
      const armItem = byN["arm" + arm.j],
        rest = arm.pose.rest;
      /**
       * The pose against rest: [dx, dy, angle].
       * @param {ArmPose | null | undefined} pose
       * @returns {number[]}
       */
      const off = (pose) =>
        pose
          ? [
              round1(pose.P[0] - rest.P[0]),
              round1(pose.P[1] - rest.P[1]),
              Math.round((pose.ang - rest.ang) * 1000) / 1000,
            ]
          : [0, 0, 0];
      return {
        rect: [armItem.at[0], armItem.at[1], armItem.bb[2], armItem.bb[3]],
        at: [armItem.bb[0], armItem.bb[1]],
        shoulder: [round1(rest.P[0]), round1(rest.P[1])],
        side: Math.sign(rest.P[0] - cx) || 1,
        left: off(arm.pose.left),
        right: off(arm.pose.right),
      };
    });
  }
  // the close-up the HUD zooms into when the car stops: its own atlas, close.rgba
  const feetModel = [
    anchorModel[0] - anchorOffset[0] / ppu,
    anchorModel[1] + anchorOffset[1] / ppu,
  ];
  const closeUp = await bakeClose(loaded, cfg, {
    renderer,
    hidden,
    ppu,
    box,
    feet: feetModel,
  });
  if (closeUp) {
    info.close = closeUp.info;
    const closeRgba = closeUp.canvas
      .getContext("2d")
      .getImageData(0, 0, closeUp.canvas.width, closeUp.canvas.height).data;
    await fetch("/out/close.rgba", {
      method: "POST",
      body: new Blob([closeRgba]),
    });
    await fetch("/out/close.png", {
      method: "POST",
      body: await new Promise((resolve) =>
        closeUp.canvas.toBlob(resolve, "image/png"),
      ),
    });
  }
  // write: raw straight-alpha RGBA (what the HUD uploads), the description, a preview
  const rgba = atlasCtx.getImageData(0, 0, atlasW, atlasH).data;
  await fetch("/out/atlas.rgba", { method: "POST", body: new Blob([rgba]) });
  await fetch("/out/atlas.json", {
    method: "POST",
    body: JSON.stringify(info, null, 1),
  });
  await fetch("/out/preview.png", {
    method: "POST",
    body: await new Promise((resolve) => atlas.toBlob(resolve, "image/png")),
  });
  log(
    "atlas " +
      atlasW +
      "x" +
      atlasH +
      " (" +
      ((atlasW * atlasH * 4) / 1048576).toFixed(2) +
      " MiB, " +
      ((atlasW * atlasH * HUD_BYTES_PER_PX) / 1048576).toFixed(2) +
      " MiB of the HUD pixel memory), " +
      items.length +
      " sprites",
  );
  const show = document.createElement("img");
  show.src = atlas.toDataURL();
  view.appendChild(show);
}

(async () => {
  try {
    const loaded = await loadModel();
    const cfg = withDefaults(await json("/config.json"));
    log(
      "model: " +
        loaded.model.parameters.count +
        " parameters, " +
        loaded.model.parts.count +
        " parts, " +
        loaded.model.drawables.count +
        " drawables, " +
        loaded.imgs.length +
        " textures",
    );
    if (/[?&]inspect/.test(location.search)) await inspect(loaded, cfg);
    else await bake(loaded, cfg);
    log("done");
    document.title = "Miku bake: done";
  } catch (err) {
    log("ERROR: " + ((err && err.stack) || err));
    document.title = "Miku bake: error";
  }
})();
