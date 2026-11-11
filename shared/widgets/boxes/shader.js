"use strict";
/** The "boxes" widget's fragment shader (GLSL ES 1.00, in boxes.glsl) for its cluster-render effect layer; index.js sends its uniforms. */
module.exports = require("../glsl")(
  require("path").join(__dirname, "boxes.glsl"),
);
