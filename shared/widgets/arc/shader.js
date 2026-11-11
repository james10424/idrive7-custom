"use strict";
/** The "arc" widget's fragment shader (GLSL ES 1.00, in arc.glsl) for its cluster-render effect layer; index.js sends its uniforms. */
module.exports = require("../glsl")(
  require("path").join(__dirname, "arc.glsl"),
);
