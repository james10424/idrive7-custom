"use strict";
/** The "f16" widget's fragment shader (GLSL ES 1.00, in f16.glsl) for its cluster-render effect layer; index.js sends its uniforms. */
module.exports = require("../glsl")(
  require("path").join(__dirname, "f16.glsl"),
);
