"use strict";
/**
 * The Miku character's fragment shaders (GLSL ES 1.00, in miku.glsl and miku_close.glsl) for her two cluster-render effect layers; index.js sends their
 * uniforms. MIKU draws her standing; MIKU_CLOSE the close-up she zooms into when the car stops, on a layer of its
 * own over her (the KOMBI's limits are per shader, so the two stay apart).
 */

/* The zoom's camera (camera.glsl), included in both shaders: z (0..1, the app's 1 s ramp) eased, then the HUD window's view of her (u_cam, in
 * the standing frame's px) zooming evenly toward the close-up's (r1): the height shrinks geometrically and the centre
 * moves as the height does, as tools/live2d_bake's bakeClose framed its zoom steps. Returns [x, y, w, h], frame px. */
const path = require("path");
const glsl = require("../glsl");

const MIKU = glsl(path.join(__dirname, "miku.glsl"));
const MIKU_CLOSE = glsl(path.join(__dirname, "miku_close.glsl"));
// a close.only bake: the close-up all the time, its layer the only one drawn (miku_only.glsl)
const MIKU_ONLY = glsl(path.join(__dirname, "miku_only.glsl"));
// the standing layer with a close.only bake: it runs her (index.js update) and draws nothing
const MIKU_NONE =
  "precision mediump float;\nvarying vec2 v_uv;\nvoid main() { gl_FragColor = vec4(0.0); }\n";

module.exports = { MIKU, MIKU_CLOSE, MIKU_ONLY, MIKU_NONE };
