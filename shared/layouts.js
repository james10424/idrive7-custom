"use strict";
/**
 * Layouts ({ schemaVersion: 2, name, theme?, modes?, widgets[] }), for the HUD or the cluster. The built-in ones are
 * hud/layouts/<name>.json (packed into hud.pack by the build). A file of the same
 * name in the app's data folder, <data>/layouts/<name>.json, overrides it: that is
 * where scripts/deploy.sh pushes an edited layout, and the folder is watched, so
 * the HUD picks it up without a restart. Which layout shows is the "hudLayout"
 * setting. Every layout is checked before use; a bad one is refused with the reason.
 */
const fs = require("fs");
const path = require("path");
const data = require("./hud_data");
const visible = require("./visible");
const { TARGET_SIZES, MAX_CONN } = require("./engine/consts");

const SCHEMA_VERSION = 2; // the layout file format this code reads
const RELOAD_DEBOUNCE_MS = 300; // after the last change in <data>/layouts/: reload once

/**
 * A layout file (hud/layouts/<name>.json or <data>/layouts/<name>.json).
 * @typedef {object} Layout
 * @property {2} schemaVersion
 * @property {string} [name]
 * @property {string} [theme]
 * @property {Array<"cruise"|"nav"|"cruiseNav">} [modes] the HUD modes it has variants for
 * @property {Widget[]} widgets
 */
/** @typedef {import("./engine/app").Widget} Widget */

const widgetTypes = require("./widgets");

/**
 * The widget types and the fields each must have (each module's "fields", shared/widgets).
 * @type {Record<string, string[]>}
 */
const TYPES = {};
Object.keys(widgetTypes).forEach((type) => {
  TYPES[type] = widgetTypes[type].fields;
});
const CLASSES = ["ambient", "content", "overlay", "alert"];
// the HUD modes a layout can have a variant for (engine/app.js header); "normal" is every layout's own
const MODES = ["cruise", "nav", "cruiseNav"];

class Layouts {
  /**
   * size: the target's [w, h] (800x480 HUD, 1920x720 cluster); widgets must fit on it.
   * @param {string} dataDir the app's data folder
   * @param {import("./shift_score").Log & { warn: (s: string) => void }} log
   * @param {number[]} [size]
   */
  constructor(dataDir, log, size) {
    this.size = size || TARGET_SIZES.hud;
    this.dir = path.join(dataDir, "layouts");
    this.log = log;
    /** @type {Array<() => void>} */
    this.changeListeners = [];
    this._watch();
  }

  /**
   * The layout called `name`, checked; throws with the reason when it can't be used.
   * @param {string} name
   * @returns {Layout}
   */
  load(name) {
    if (!/^[a-z0-9_-]+$/i.test(String(name)))
      throw new Error('bad layout name "' + name + '"');
    const own = path.join(this.dir, name + ".json");
    let raw;
    if (fs.existsSync(own)) {
      try {
        raw = JSON.parse(fs.readFileSync(own, "utf8"));
      } catch (err) {
        throw new Error(
          "layouts/" + name + ".json is not valid JSON (" + err.message + ")",
        );
      }
    } else {
      raw = data.json("layouts/" + name + ".json");
      if (!raw || !Object.keys(raw).length)
        throw new Error('there is no layout "' + name + '"');
    }
    this._validate(raw, name);
    // Warn (never refuse) about widgets the driver cannot see: under the hood, under BMW's
    // gear box or belt light on the cluster, outside the windshield window on the HUD.
    const target = this.size[0] === TARGET_SIZES.panel[0] ? "panel" : "hud";
    visible
      .check(raw.widgets, target)
      .forEach((warning) => this.log.warn('layout "' + name + '": ' + warning));
    return raw;
  }

  /**
   * Throws with the reason when `layout` is not a usable layout.
   * @param {any} layout the parsed file
   * @param {string} name
   */
  _validate(layout, name) {
    /** @type {(why: string) => never} */
    const bad = (why) => {
      throw new Error('layout "' + name + '": ' + why);
    };
    if (!layout || typeof layout !== "object") bad("not an object");
    if (layout.schemaVersion !== SCHEMA_VERSION)
      bad(
        "schemaVersion must be " +
          SCHEMA_VERSION +
          " (got " +
          layout.schemaVersion +
          ")",
      );
    if (!Array.isArray(layout.widgets)) bad("missing widgets array");
    if (
      layout.modes !== undefined &&
      !(
        Array.isArray(layout.modes) &&
        layout.modes.every((/** @type {string} */ mode) => MODES.indexOf(mode) >= 0)
      )
    )
      bad('"modes" must list some of ' + MODES.join(", "));
    /** @type {Record<string, boolean>} */
    const ids = {};
    layout.widgets.forEach((/** @type {Widget} */ widget, /** @type {number} */ i) => {
      const label = "widgets[" + i + '] ("' + widget.id + '")';
      if (!widget.id) bad("widgets[" + i + "] has no id");
      if (ids[widget.id]) bad('two widgets are called "' + widget.id + '"');
      ids[widget.id] = true;
      if (!TYPES[widget.type])
        bad(label + ' has unknown type "' + widget.type + '"');
      ["x", "y", "w", "h"].forEach((k) => {
        if (typeof widget[k] !== "number" || widget[k] < 0)
          bad(label + " needs a number " + k);
      });
      if (
        widget.x + widget.w > this.size[0] ||
        widget.y + widget.h > this.size[1]
      )
        bad(
          label +
            " runs off the " +
            this.size[0] +
            "x" +
            this.size[1] +
            " display",
        );
      if (widget.class && CLASSES.indexOf(widget.class) < 0)
        bad(label + ' has unknown class "' + widget.class + '"');
      if (widget.exclusive)
        bad(
          label +
            " sets exclusive, which would hide everything under it (the CarPlay / Android Auto map too)",
        );
      if (
        widget.conn !== undefined &&
        !(Number.isInteger(widget.conn) && widget.conn >= 0 && widget.conn <= MAX_CONN - 1)
      )
        bad(
          label +
            ' "conn" must be 0..' +
            (MAX_CONN - 1) +
            " (the connection to cluster-render)",
        );
      if (
        widget.toggle !== undefined &&
        !/^!?[a-zA-Z0-9_]+(=[a-zA-Z0-9_]+)?$/.test(String(widget.toggle))
      )
        bad(label + ' has a bad toggle "' + widget.toggle + '"');
      if (widget.in !== undefined) {
        if (
          !widget.in ||
          typeof widget.in !== "object" ||
          Array.isArray(widget.in)
        )
          bad(label + ' "in" must be { mode: { fields } | false }');
        Object.keys(widget.in).forEach((mode) => {
          const override = widget.in[mode];
          if (mode !== "normal" && MODES.indexOf(mode) < 0)
            bad(
              label +
                ' "in" has unknown mode "' +
                mode +
                '" (normal, ' +
                MODES.join(", ") +
                ")",
            );
          if (override === false) return;
          if (
            !override ||
            typeof override !== "object" ||
            Array.isArray(override) ||
            override.id !== undefined ||
            override.type !== undefined ||
            override.in !== undefined
          )
            bad(
              label +
                ' "in".' +
                mode +
                " must be false or fields to change (not id, type or in)",
            );
          const merged = Object.assign({}, widget, override);
          ["x", "y", "w", "h"].forEach((k) => {
            if (typeof merged[k] !== "number" || merged[k] < 0)
              bad(label + " in " + mode + " needs a number " + k);
          });
          if (
            merged.x + merged.w > this.size[0] ||
            merged.y + merged.h > this.size[1]
          )
            bad(
              label +
                " in " +
                mode +
                " runs off the " +
                this.size[0] +
                "x" +
                this.size[1] +
                " display",
            );
        });
      }
      if (
        widget.hole !== undefined &&
        !(
          Array.isArray(widget.hole) &&
          widget.hole.length === 4 &&
          widget.hole.every((/** @type {unknown} */ value) => typeof value === "number")
        )
      )
        bad(label + ' "hole" must be [x, y, w, h]');
      TYPES[widget.type].forEach((k) => {
        if (widget[k] === undefined)
          bad(label + " (" + widget.type + ') needs "' + k + '"');
      });
    });
  }

  /**
   * listener() after <data>/layouts/ changes on disk.
   * @param {() => void} listener
   */
  onChange(listener) {
    this.changeListeners.push(listener);
  }

  /** Watches <data>/layouts/ (creating it when missing). */
  _watch() {
    try {
      fs.mkdirSync(this.dir);
    } catch (err) {
      /* there already, or the data folder is read-only */
    }
    try {
      fs.watch(this.dir, { persistent: false }, () => {
        // debounce: an rsync push touches several files in quick succession
        clearTimeout(this._timer);
        this._timer = setTimeout(() => {
          this.log.info("layouts/ changed on disk, reloading");
          this.changeListeners.forEach((listener) => {
            try {
              listener();
            } catch (err) {
              this.log.warn("layouts listener: " + err);
            }
          });
        }, RELOAD_DEBOUNCE_MS);
      });
    } catch (err) {
      this.log.warn(
        "layouts: cannot watch " +
          this.dir +
          " (" +
          err.message +
          "); a pushed layout shows after an app restart",
      );
    }
  }
}

module.exports = Layouts;
