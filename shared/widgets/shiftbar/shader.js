"use strict";
/** The "shiftbar" widget's fragment shader (GLSL ES 1.00, in shiftbar.glsl) for its cluster-render effect layer; index.js sends its uniforms. */
module.exports = require("../glsl")(
  require("path").join(__dirname, "shiftbar.glsl"),
);
