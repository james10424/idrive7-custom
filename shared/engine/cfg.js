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
  /** @type {Record<string, string>} */
  const SWIZZLE = { float: ".x", vec2: ".xy", vec3: ".xyz", vec4: "" };
  let defs =
    "uniform vec4 u_cfg[" +
    names.length +
    "];   // the set-once values, one slot each (shaders.js CFG)\n";
  names.forEach((name, i) => {
    const pattern = new RegExp(
      "^uniform\\s+(float|vec2|vec3|vec4)\\s+" + name + "\\s*;([^\\n]*)\\n",
      "m",
    );
    const match = pattern.exec(src);
    if (!match) throw new Error("packCfg: no uniform " + name);
    src = src.replace(match[0], "");
    defs +=
      "#define " +
      name +
      " u_cfg[" +
      i +
      "]" +
      SWIZZLE[match[1]] +
      (match[2].trim() ? "   " + match[2].trim() : "") +
      "\n";
  });
  const insertAt = src.search(
    /^(?:const |float |vec[234] |bool |void |#define )/m,
  ); // after the uniforms, before the first code
  return src.slice(0, insertAt) + defs + src.slice(insertAt);
}

module.exports = { packCfg };
