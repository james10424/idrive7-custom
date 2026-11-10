"use strict";
/* cluster-render keeps at most 32 uniform names a layer. The set-once values of the big layouts' shaders (geometry,
 * shapes, colours) go up as one vec4 array, u_cfg, one slot each in this order; the shader keeps their old names through
 * #define (a float is .x, a vec2 .xy, a vec3 .xyz). The values that change while driving stay their own uniforms, so a
 * tick still sends only what changed. The engine's _cfgPacker packs the values in the same order (a widget module's "cfg"). */

/**
 * Moves the named uniforms of a shader into the u_cfg vec4 array, keeping their names through #define.
 * @param {string} src GLSL source
 * @param {string[]} names uniforms, in slot order
 * @returns {string} the packed source
 */
function packCfg(src, names) {
  // the comment below is part of the GLSL sent to the car; it is kept word for word
  const SW = { float: ".x", vec2: ".xy", vec3: ".xyz", vec4: "" };
  let defs =
    "uniform vec4 u_cfg[" +
    names.length +
    "];   // the set-once values, one slot each (shaders.js CFG)\n";
  names.forEach((n, i) => {
    const re = new RegExp(
      "^uniform\\s+(float|vec2|vec3|vec4)\\s+" + n + "\\s*;([^\\n]*)\\n",
      "m",
    );
    const m = re.exec(src);
    if (!m) throw new Error("packCfg: no uniform " + n);
    src = src.replace(m[0], "");
    defs +=
      "#define " +
      n +
      " u_cfg[" +
      i +
      "]" +
      SW[m[1]] +
      (m[2].trim() ? "   " + m[2].trim() : "") +
      "\n";
  });
  const at = src.search(/^(?:const |float |vec[234] |bool |void |#define )/m); // after the uniforms, before the first code
  return src.slice(0, at) + defs + src.slice(at);
}

module.exports = { packCfg };
