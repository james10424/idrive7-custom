"use strict";
/** The "revbar" widget's fragment shader (GLSL ES 1.00, in revbar.glsl) for its cluster-render effect layer; index.js sends its uniforms. */
module.exports = require("../glsl")(
  require("path").join(__dirname, "revbar.glsl"),
);
