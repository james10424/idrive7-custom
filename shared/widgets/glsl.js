"use strict";
/**
 * Reads a widget's shader from its .glsl file (GLSL ES 1.00, the text cluster-render compiles on the cluster's GPU).
 * A line `#include "name.glsl"` is replaced by that file's text (relative to the file that includes it), so pieces
 * two shaders share live once. Read once, when the widget's module loads; the build ships the .glsl files with the
 * widgets folder. tools/shader_budget.js compiles every shader with glslangValidator.
 */
const fs = require("fs");
const path = require("path");

const INCLUDE = /^#include "([^"]+)"[ \t]*\r?\n?/gm;

/**
 * @param {string} file absolute path of the .glsl file
 * @param {string[]} [stack] the files including this one (a loop is an error)
 * @returns {string} the shader's source with every include in place
 */
function loadGlsl(file, stack) {
  const chain = (stack || []).concat(file);
  if ((stack || []).indexOf(file) >= 0)
    throw new Error("glsl: include loop: " + chain.join(" -> "));
  const text = fs.readFileSync(file, "utf8");
  return text.replace(INCLUDE, (line, name) =>
    loadGlsl(path.join(path.dirname(file), name), chain),
  );
}

module.exports = loadGlsl;
