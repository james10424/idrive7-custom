"use strict";
/** The "lights" widget's fragment shader (GLSL ES 1.00, in lights.glsl) for its cluster-render effect layer; index.js sends its uniforms. */
module.exports = require("../glsl")(
  require("path").join(__dirname, "lights.glsl"),
);
