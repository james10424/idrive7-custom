"use strict";
/** The calibration grid's fragment shader (GLSL ES 1.00, in grid.glsl) for its cluster-render effect layer; index.js sends its uniforms. */
module.exports = require("../glsl")(
  require("path").join(__dirname, "grid.glsl"),
);
