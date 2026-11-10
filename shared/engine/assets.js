"use strict";
/**
 * Assets kept across rebuilds (glyph atlases, the car's own font), and the u_cfg packer for big shaders.
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const textRaster = require("../hud_text");
const widgetTypes = require("../widgets");
const { mib } = require("./util");

/** @typedef {import("./app").GlyphAtlas} GlyphAtlas */
/** @typedef {import("./app").CfgPacker} CfgPacker */
/** @typedef {import("../cluster_render_client.js").ClusterRender} Client */

module.exports = /** @satisfies {ThisType<import("./app").App>} */ ({
  /**
   * The glyph atlas of a font on a connection: an R8 asset of the font's characters in equal cells (cols x
   * rows), made on first use and kept while the connection lives (the client re-sends it by itself after a
   * reconnect). A widget's effect layer samples it; nothing is drawn by the asset itself.
   * @param {string} fontName
   * @param {number} connIndex connection index
   * @returns {GlyphAtlas}
   */
  _atlas(fontName, connIndex) {
    const key = connIndex + ":" + fontName;
    if (this.atlases.has(key)) return this.atlases.get(key);
    const font = textRaster.loadFont(fontName),
      glyphs = font.metrics.glyphs;
    const chars = Object.keys(glyphs)
      .filter((char) => char.length === 1 && char >= " " && char <= "~")
      .sort()
      .slice(0, 64);
    if (!chars.length)
      throw new Error(
        'font "' + fontName + '" has no printable glyphs for an atlas',
      );
    const cellW =
      Math.max(
        1,
        Math.ceil(
          Math.max.apply(
            null,
            chars.map((char) => glyphs[char].advance),
          ),
        ),
      ) + 2;
    const cellH = font.metrics.cellHeight;
    const cols = Math.max(1, Math.min(16, Math.floor(2048 / cellW))),
      rows = Math.ceil(chars.length / cols);
    const w = cols * cellW,
      h = rows * cellH;
    const buf = Buffer.alloc(w * h, 0);
    chars.forEach((char, i) => {
      const cell = textRaster.mask(cellW, cellH, char, {
        font: fontName,
        align: "center",
      });
      const cellX = (i % cols) * cellW,
        cellY = Math.floor(i / cols) * cellH;
      for (let y = 0; y < cellH; y++)
        cell.copy(buf, (cellY + y) * w + cellX, y * cellW, (y + 1) * cellW);
    });
    const client = this._clientAt(connIndex);
    const ref = client.asset({
      target: this.target,
      format: "r8",
      w,
      h,
      sampling: "bilinear",
    });
    if (!ref)
      throw new Error(
        'font "' + fontName + '": atlas asset refused (' + w + "x" + h + ")",
      );
    client.pixels(ref, null, buf);
    const atlas = {
      ref,
      c: client,
      ci: connIndex,
      cols,
      rows,
      cellW,
      cellH,
      chars,
      bytes: w * h * 2,
    };
    this.atlases.set(key, atlas);
    this.log.info(
      'glyph atlas "' +
        fontName +
        '"' +
        (connIndex ? " on connection " + (connIndex + 1) : "") +
        ": " +
        chars.length +
        " glyphs in " +
        cellW +
        "x" +
        cellH +
        " cells, " +
        w +
        "x" +
        h +
        " R8 asset, " +
        mib(atlas.bytes) +
        " of pixel memory",
    );
    return atlas;
  },

  /**
   * The pixel memory of every atlas kept.
   * @returns {number}
   */
  _atlasBytes() {
    let total = 0;
    this.atlases.forEach((atlas) => {
      total += atlas.bytes;
    });
    return total;
  },

  /** The car's own font for text in any script (app.json config.music.fonts: paths tried in order, a fallback chain);
   *  null when none of them loads.
   * @returns {*} a sysfont.js font (mask()), or null
   */
  _sysFont() {
    if (this.sysFontTried) return this.sysFont;
    this.sysFontTried = true;
    const music = this.config.music || {};
    const sysfont = require("../sysfont"); // only in apps that ship it (app.json "shared")
    this.sysFont = sysfont.open(music.fonts || [], this.log);
    if (!this.sysFont && Array.isArray(music.searchIn)) {
      // none of the listed files: look for the car's own fonts, and log them all so the paths can go in config
      const found = sysfont.find(
        music.searchIn,
        music.searchMax,
        music.searchMaxBytes,
        this.log,
      );
      this.log.info(
        "font files found (" +
          found.all.length +
          "): " +
          found.all
            .slice(0, 60)
            .map(
              (font) => font.path + " " + Math.round(font.size / 1024) + " KiB",
            )
            .join(", "),
      );
      this.sysFont = found.fonts;
    }
    if (!this.sysFont)
      this.log.info(
        "no system font found (config.music.fonts / searchIn): the music title stays blank",
      );
    return this.sysFont;
  },

  /** {{token}} -> display text. */
  /** Collects a big shader's set-once uniforms (its module's "cfg") into its one u_cfg vec4 array, sent by flush(); any
   *  other uniform goes straight through. cluster-render keeps at most 32 uniform names a layer.
   * @param {Client} client
   * @param {number} ref
   * @param {string} type the widget type
   * @returns {CfgPacker}
   */
  _cfgPacker(client, ref, type) {
    const names = (widgetTypes[type] && widgetTypes[type].cfg) || [],
      vals = {};
    return {
      uniform: (name, value, opts) => {
        if (names.indexOf(name) >= 0) vals[name] = value;
        else client.uniform(ref, name, value, opts);
      },
      flush: () => {
        const flat = [];
        names.forEach((name) => {
          const slot = (vals[name] || []).slice(0, 4);
          while (slot.length < 4) slot.push(0);
          flat.push(...slot);
        });
        client.uniform(ref, "u_cfg", flat, { type: "vec4" });
      },
    };
  },
});
