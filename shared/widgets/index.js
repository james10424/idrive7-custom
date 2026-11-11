"use strict";
/**
 * The widget types: type name -> its module (shared/widgets/<type>/index.js). The engine (shared/engine) and the
 * layout check (shared/layouts.js) know a widget only through this table.
 *
 * A module exports:
 *   type     its name, as layouts write it
 *   fields   the fields a layout must give it (layouts.js refuses one without them)
 *   docs     what it draws and the fields it reads
 *   image    true: drawn as pixels (an image layer, packed into a sheet unless "own": true); else an effect layer
 *   shader(hud, w, ci)        an effect type's fragment shader, or null when it can't draw now (it logged why)
 *   time     true: cluster-render animates the effect on its own clock
 *   shaders  { name: GLSL } every shader it can send, for tools/shader_budget.js
 *   create(hud, w, x)         sets up its layer once made (fixed uniforms, the first paint)
 *   update(hud, x, now, force)  sends what changed (force: everything)
 */
/** @type {Record<string, *>} */
const TYPES = {
  miku: require("./miku"),
  rdash: require("./rdash"),
  shiftbar: require("./shiftbar"),
  arc: require("./arc"),
  revbar: require("./revbar"),
  lights: require("./lights"),
  fill: require("./fill"),
  box: require("./box"),
  grid: require("./grid"),
  segbar: require("./segbar"),
  mdash: require("./mdash"),
  mtach: require("./mtach"),
  sdash: require("./sdash"),
  boxes: require("./boxes"),
  atext: require("./atext"),
  odo: require("./odo"),
  text: require("./text"),
  scale: require("./scale"),
  stripe: require("./stripe"),
  badge: require("./badge"),
  gridlabels: require("./grid/labels"),
  icon: require("./icon"),
  swatch: require("./swatch"),
  swatchimg: require("./swatch/image"),
};

module.exports = TYPES;
