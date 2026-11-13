"use strict";
/**
 * The drawing engine, shared by every bimmer-lab app that draws through cluster-render
 * (robertnisipeanu/idrive-apps, native/cluster-render): it connects, builds the active layout's layers in
 * the active theme (one effect layer per shader widget, the image widgets packed into sheets, below), and
 * keeps live widgets updated from the car's data (car/).
 * Started by an app's main.js with the kit's ctx (settings, signals, log, spec, dataDir).
 * It lives in the repo's shared/ folder (engine/, car/, widgets/); app.json "shared" ships them with each app.
 *
 * Which display: app.json config.target, "hud" (800x480, the windshield HUD; the default) or
 * "panel" (1920x720, the whole instrument cluster, drawn over BMW's own gauges).
 * config.statusName names it on the status row ("HUD", "Cluster").
 * Which layout: while BMW's route guidance is on, the "navLayout" setting (apps that have it: the cluster; "same" = no
 * switch; the map window is open then whatever "mapWindow" says); else, with the "byMode" setting on (apps that have it) and
 * the car's drive mode known (FES statusFESVehicleDynamicSwitchHMI), the "inComfort" / "inSport" / "inEco" setting;
 * otherwise "hudLayout".
 * The layout name "off" draws nothing, so BMW's own HUD or cluster shows (and the other app can have the
 * shared scene: cluster-render never shows the HUD and the cluster panel at once).
 * HUD modes (the "makeRoom" setting, HUD apps that have it): BMW's own HUD content doesn't show where our
 * layers are (car photos, Nov 7 2026), so the layout makes room for it. The mode is "normal", "cruise"
 * (BMW's driver assistance block is up: the ACC car and distance bars, the ACC / DCC / STA symbol or a lit
 * lane-assist wheel, from displaydataserver.DisplayDataServer functionalLibraryData), "nav" (route guidance:
 * navigation.guiding.Guidance guidanceState ACTIVE, Main_Instance, as BMW's own oap-sdk reads it; the street
 * name, the turn map and the distance fill the right of the window) or "cruiseNav" (both). A layout lists the
 * modes it has a variant for in "modes"; in any other mode but normal it draws nothing, so BMW's shows.
 * A widget's "in": { "<mode>": { fields } | false } moves or restyles it in that mode, or hides it (false);
 * "normal": false makes a widget that only shows in the other modes.
 * The colour theme is the layout's own "theme" when it has one (the cluster themes), else the "hudTheme"
 * setting (auto = Night after sunset).
 *
 * Effect shaders: cluster-render's v_uv has (0,0) at the TOP-left (PROTOCOL.md; confirmed on the car,
 * Nov 4 2026, when a box's header strip drew at the bottom). The bench draws the same way.
 *
 * Layer packing (Nov 5 2026): cluster-render drew at most 8 layers per client connection (its
 * CompositorLimits.per_client; 32 across all clients; a 9th is refused with "too many layers"; 0.4.2 raised these to
 * 64 and 96, and LAYER_BUDGET follows), which the car
 * photos showed as a theme's shaders plus the first few text widgets. So the image widgets (a module with "image": true) are
 * packed into SHEETS, one image layer per sheet, instead of one layer each. Widgets are grouped by
 * (class, z) and placed in file order: a widget goes into the first sheet of its group opened after every
 * earlier layer or widget its rect intersects (so an image widget never clobbers one it overlaps, and
 * file order still decides what is on top) AND whose union box with it stays within the sheet size limit,
 * else a new sheet is opened. A sheet's rect is the union box of its members (iw/ih that size). On create
 * every member is painted into a local buffer and the sheet is sent whole once (a 1920x720 RGBA whole write
 * is 5,529,600 bytes, under the 5,529,664 message limit; the client keeps its own whole copy); after that
 * every member update is a dirty rect of the sheet, translated by the sheet's offset (_blit; a widget
 * that paints small rects keeps them). Effect widgets are one layer each, as before. An image widget with
 * "own": true gets its own layer as before (the calibration probes use it to count how many layers the car
 * draws).
 * Sheet size vs layer count: a rebuild re-sends every sheet whole, through the car's upload budget (floor
 * 2000 KB/s, ceiling 5500, the HUD gets at most half), so sheets are kept small: the limit starts at a
 * quarter of the target area (345,600 px on the panel, 96,000 on the HUD). If that needs more than
 * LAYER_BUDGET (64) layers on a connection (effects + own + sheets), the limit is doubled and the layout re-planned,
 * up to unlimited; if even unlimited needs more, a warning says so and the layout is drawn anyway.
 * The rebuild log line names the layout, widget and layer counts, the limit used and the bytes of the
 * whole-sheet writes; the status row names the layer count, not the widget count; and two seconds after a
 * rebuild cluster-render's own status text is asked for and logged.
 *
 * Widget types: one module each in shared/widgets (the registry, shared/widgets/index.js, maps a layout's "type" to
 * it; each module's "docs" says what it draws and the fields it reads). The engine names no type: it plans, creates
 * and updates every widget through its module (docs/ARCHITECTURE.md).
 * Any image widget: "own": true gives it its own image layer instead of a place in a packed sheet (above).
 * Any widget: "conn": 0..3 puts its layer (or its sheet) on that connection to cluster-render. The layer limit
 *   is per connection, so a second socket from the same app gets another 64 (8 before 0.4.2: DukeAPenguin saw 28 layers over four
 *   sockets on his car, Nov 5 2026; the calibration grids probe it here: L5..L16 on connections 2..4). 0 (the
 *   default) is the app's own connection; a layout never asks for more than it needs, each extra one is opened
 *   on first use and named <app id>_<n>. Sheets never span connections.
 * Pixel memory: cluster-render has 32 MiB (our fork's pixel_mib, 0.5.4; upstream 16) for every app's images together and counts each image twice
 *   (Compositor::add_image; a layer past it is refused with "the service's pixel memory is full"), so every
 *   image layer costs w*h*8 bytes. The rebuild log and the status row say what a layout costs.
 * An image widget's repaint (_blitDiff) sends only the one rectangle around the pixels that changed since the last
 *   paint (engine/plan.js changes(), after PenguinDukeYDAuto/idrive7-EVAHUD's eva_canvas.js, MIT): a 3-digit readout
 *   that goes 123 -> 124 sends its last digit, not the widget.
 * Any widget: "toggle": "<bool setting>" hides it when that setting is off, "!<setting>" when it is on,
 * "<choice setting>=<value>" shows it only while that choice is picked (also with "!");
 * "themes": [...] shows it only in those themes.
 *
 * Never throws out of a timer or event: the kit turns an uncaught exception into an
 * app exit, and on the car a second unexpected exit uninstalls the app.
 */
const Layouts = require("../layouts");
const { useBackdrop, noBackdrop } = require("./backdrop");
const widgetTypes = require("../widgets");
const { ClusterRender, DEFAULT_PATH } = require("../cluster_render_client.js");
const {
  DEFAULT_LOCATION,
  LAYER_BUDGET,
  MODE_TEXT,
  PIXEL_BYTES,
  IMAGE_PX_BYTES,
  SHEET_AREA_FRAC,
  STATUS_ASK_MS,
  TARGET_SIZES,
  TICK_MS,
  isImage,
} = require("./consts");
const { THEMES } = require("../hud_themes");
const { isNum, mib } = require("./util");

const THEME_CHECK_MS = 60000; // the Auto theme's sunrise / sunset check
const STATUS_MS = 5000; // the status line's refresh
const FLASH_RPM = 150; // the shift light blinks from this far under the redline
const FLASH_HALF_MS = 62.5; // the shift light's blink: on and off this long each (8 Hz)

/** @typedef {import("../cluster_render_client.js").ClusterRender} Client */
/**
 * @typedef {object} Log
 * @property {(s: string) => void} info
 * @property {(s: string) => void} warn
 * @property {(s: string) => void} error
 */

/**
 * A setting's schema entry (ctx.settings.item).
 * @typedef {object} SettingItem
 * @property {string} type "bool", "choice", "number", ...
 * @property {Array<Array<*>>} [options] choices: [value, label]
 * @property {number[]} [steps] numbers: the allowed values
 * @property {*} [default]
 */

/**
 * The HudApp constructor's ctx: the kit's app context.
 * @typedef {object} HudCtx
 * @property {Log} log
 * @property {{ text: (id: string, s: string) => void }} ui
 * @property {object} settings
 * @property {(key: string) => *} settings.get
 * @property {(key: string) => (SettingItem | undefined)} settings.item
 * @property {(fn: (key: string) => void) => void} settings.onChange
 * @property {(key: string, value: *) => void} settings.set
 * @property {{ watch: (iface: string, instance: string,
 *   handlers: Record<string, ((msg: never) => void) | number>, log: Log) => Promise<Subscription>
 * }} signals the car's SOME/IP signals (a handler's payload: someip.d.ts)
 * @property {{ id: string, config?: HudConfig }} spec app.json
 * @property {string} [dataDir] the app's data folder
 */
/**
 * A watch's subscription (kit/runtime/signals.js).
 * @typedef {object} Subscription
 * @property {string} [error] why it failed
 * @property {boolean} [available] the interface's provider is there
 * @property {() => void} shutdown stops watching
 */

/**
 * app.json "config" (see the header for what each does).
 * @typedef {object} HudConfig
 * @property {"hud" | "panel"} [target]
 * @property {string} [statusName]
 * @property {string} [socketPath]
 * @property {{ lat: number, lon: number }} [location]
 * @property {Record<string, string>} [choiceAliases]
 * @property {Record<string, *>} [fixedSettings] values for settings the app no longer offers (a saved value is ignored)
 * @property {Record<string, *>} [acc] gap / rel / set: { factor, offset }
 * @property {Record<string, *>} [pedal]
 * @property {{ factor?: number, offset?: number }} [battery]
 * @property {{ factor?: number, offset?: number }} [consumption]
 * @property {{ torqueNm?: number, powerKw?: number }} [engine]
 * @property {Record<string, *>} [dme] engine unit reads (read-only UDS)
 * @property {Record<string, *>} [music]
 * @property {number} [tankLitres]
 * @property {number} [utcOffsetMinutes]
 * @property {boolean} [lamps]
 * @property {boolean} [pedals]
 * @property {boolean} [indicators]
 * @property {boolean} [carAhead]
 */

/**
 * A widget's common fields as read from a layout file (see the header);
 * each type's own fields are in Widget's index signature (and its module's docs).
 * @typedef {object} WidgetFields
 * @property {string} id
 * @property {string} type a widget type (shared/widgets)
 * @property {number} x target px
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {string} [class] the layer class ("content")
 * @property {number} [z]
 * @property {number} [conn] connection 0..3
 * @property {boolean} [own] an image widget on its own layer
 * @property {string} [toggle] "<setting>", "!<setting>", "<choice>=<value>"
 * @property {string[]} [themes]
 * @property {Record<string, object | false>} [in] per HUD mode
 * @property {string} [text] template with {{tokens}}
 * @property {string} [signal]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number[]} [range] [lo, hi]
 * @property {number[]} [hole] [x, y, w, h] target px
 * @property {string} [holeWhen]
 * @property {number} [holeInset]
 * @property {number} [holeRadius]
 */
/** @typedef {WidgetFields & Record<string, *>} Widget */

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * A packed image layer (_plan, _createSheet).
 * @typedef {object} Sheet
 * @property {"sheet"} kind
 * @property {string} klass
 * @property {number} z
 * @property {number} conn
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {Widget[]} members
 * @property {number} ref 0 until made
 * @property {?Client} c
 * @property {number} ci
 * @property {?Buffer} buf the whole sheet while it is being filled
 */
/**
 * An effect or "own" image widget's layer in a plan.
 * @typedef {{ kind: "layer", w: Widget, klass: string, z: number,
 *   conn: number }} LayerEntry
 */
/** @typedef {LayerEntry | Sheet} PlanEntry */

/**
 * A font's glyph atlas on a connection (_atlas): an R8 asset.
 * @typedef {object} GlyphAtlas
 * @property {number} ref
 * @property {Client} c
 * @property {number} ci
 * @property {number} cols
 * @property {number} rows
 * @property {number} cellW
 * @property {number} cellH
 * @property {string[]} chars the glyph at each cell
 * @property {number} bytes pixel memory
 */

/**
 * The engine's state per drawn widget (this.widgets).
 * @typedef {WidgetStateCore & Record<string, *>} WidgetState
 */
/**
 * @typedef {object} WidgetStateCore
 * @property {Widget} w
 * @property {number} ref its layer, or its sheet's
 * @property {Client} c
 * @property {number} ci connection index
 * @property {?Sheet} sheet
 * @property {unknown} last the last values sent (a key, as the widget type makes it)
 * @property {number} lastPaint ms
 * @property {?boolean} px painted at least once (_blitDiff; the pixels themselves are the client's layer copy)
 * @property {ReturnType<typeof setInterval>} [timer] its own update timer (a module that sets one: the tick skips it)
 * @property {number} [at] ms of the last eased update
 * @property {boolean} [refused] cluster-render refused something it sent (its layer, a bind, a uniform)
 * A widget module keeps its own state on it too (see its typedef).
 */
/**
 * HudApp with the methods the engine and car files add to its prototype (mixin, at the end of this file): what
 * widget modules get as their app, and `this` inside those files. Declared in app_type.d.ts (an interface: as a
 * typedef here it referenced itself, and TypeScript made it any).
 * @typedef {import("./app_type").App} App
 */
/** @typedef {{ c: Client, ci: number, ref: number, key: string }} LayerRef */
/** @typedef {{ state: string, reason?: string }} LayerState */
/**
 * @typedef {{ state: string, holder?: string, reason?: string,
 *   disabled: boolean }} TargetState
 */
/**
 * _cfgPacker's result.
 * @typedef {object} CfgPacker
 * @property {(name: string, value: number[], opts?: object) => void} uniform
 * @property {() => void} flush
 */

class HudApp {
  /**
   * @param {HudCtx} ctx
   */
  constructor(ctx) {
    /** this, with the methods the engine and car files add (App): what the constructor calls of them */
    const app = /** @type {App} */ (/** @type {unknown} */ (this));
    this.ctx = ctx;
    this.log = ctx.log;
    /** @type {HudConfig} */
    this.config = (ctx.spec && ctx.spec.config) || {};
    this.location = this.config.location || DEFAULT_LOCATION;
    // HUD_CLUSTER_SOCKET: the Mac bench's fake cluster-render; never set on the car
    this.socketPath =
      process.env.HUD_CLUSTER_SOCKET || this.config.socketPath || DEFAULT_PATH;
    /** @type {Client[]} */
    this.clients = []; // the connections to cluster-render: [0] the app's own, more for "conn" widgets
    this.started = false;
    /** @type {Map<string, LayerState>} */
    this.layerStates = new Map(); // "<conn>:<ref>" -> { state, reason } from cluster-render
    this.client = this._clientAt(0);
    this.target = TARGET_SIZES[this.config.target] ? this.config.target : "hud";
    this.size = TARGET_SIZES[this.target];
    this.label = this.config.statusName || "HUD";
    /** @type {?string} */
    this.layoutTheme = null; // the active layout's own theme, if it has one
    this.layouts = new Layouts(ctx.dataDir, this.log, this.size);
    /** @type {Map<string, WidgetState>} */
    this.widgets = new Map(); // widget.id -> { w, ref, sheet | null, last, lastPaint }
    /** @type {Sheet[]} */
    this.sheets = []; // the packed image layers: { ref, klass, z, x, y, w, h, members, buf }
    app._initCar(); // the car's values (car/signals.js)
    this.activeMode = "normal"; // the HUD mode the layers were built for
    /** @type {?string} */
    this.activeName = null; // the layout shown now ('off' = nothing)
    this.pixelBytes = 0; // what the layout's image layers and glyph atlases cost of cluster-render's pixel memory
    /** @type {Map<string, GlyphAtlas | Record<string, *>>} */
    this.atlases = new Map(); // "<conn>:<font>" -> glyph atlas { ref, c, ci, cols, rows, cellW, cellH, chars, bytes } (R8), other keys: a widget module's own assets; assets kept across rebuilds
    /** @type {?TargetState} */
    this.targetState = null; // { state, holder, reason } of our target
    /** @type {?number} */
    this.rpmF = null;
    /** @type {?number} */
    this.rpmShown = null;
    this.lastTickT = 0;
    /** @type {?string} */
    this.themeName = null;
    this.flash = false;
    /** @type {?string} */
    this.problem = null; // why nothing shows (a bad layout), for the status line
    /** @type {?import("./backdrop").Backdrop} a layout's baked backdrop (engine/backdrop.js), null without one */
    this.backdrop = null;
    /** @type {Array<(text: string, detail: string) => void>} */
    this.statusListeners = [];
    /** @type {?string} */
    this.lastStatus = null;

    /** @type {Map<string, *>} setting() values, cleared when any setting changes */
    this.settingCache = new Map();
    app._setupVehicleData();
    this.layouts.onChange(() => this._rebuild());
    ctx.settings.onChange((key) => {
      this.settingCache.clear();
      if (key === "mikuReset") this._resetAnim(key);
      else if (key !== "demo") this._rebuild();
      else app._status();
    });
  }

  /**
   * A setting's value, or its default when the saved value isn't one the schema allows.
   * @param {string} key
   * @returns {*}
   * @this {App}
   */
  setting(key) {
    // while the "navLayout" switch is in force the map window is open, whatever "mapWindow" says
    if (key === "mapWindow" && this._navSwitch()) return true;
    // looked up once per change: tokens ask for the units on every one, a tick asks hundreds of times
    if (this.settingCache.has(key)) return this.settingCache.get(key);
    const value = this._settingNow(key);
    this.settingCache.set(key, value);
    return value;
  }

  /**
   * setting() without the cache.
   * @param {string} key
   * @returns {*}
   * @this {App}
   */
  _settingNow(key) {
    const item = this.ctx.settings.item(key);
    // a setting the app no longer offers: its fixed value (app.json config.fixedSettings), never a value saved before
    const fixed = this.config.fixedSettings;
    if (!item && fixed && Object.prototype.hasOwnProperty.call(fixed, key))
      return fixed[key];
    const value = this.ctx.settings.get(key);
    if (!item) return value;
    // a choice that was renamed or replaced (app.json config.choiceAliases, e.g. a layout that was renamed)
    const alias =
      item.type === "choice" &&
      this.config.choiceAliases &&
      this.config.choiceAliases[value];
    if (alias && (item.options || []).some((option) => option[0] === alias))
      return alias;
    const valid =
      item.type === "bool"
        ? typeof value === "boolean"
        : item.type === "choice"
          ? (item.options || []).some((option) => option[0] === value)
          : item.type === "number"
            ? isNum(value) && (!item.steps || item.steps.indexOf(value) >= 0)
            : true;
    return valid ? value : item.default;
  }

  /**
   * Connection i to cluster-render, made on first use: 0 is the app's own (named after the app); a widget's
   * "conn" asks for 1..3, named <app id>_2 .. _4, each with its own 64 layers. Layers made before a connection
   * is up are replayed by the client when it connects.
   * @param {number} i
   * @returns {Client}
   * @this {App}
   */
  _clientAt(i) {
    while (this.clients.length <= i) {
      const connIndex = this.clients.length;
      const client = new ClusterRender(
        connIndex ? this.ctx.spec.id + "_" + (connIndex + 1) : this.ctx.spec.id,
        this.socketPath,
      );
      this.clients.push(client);
      this._wireClientEvents(client, connIndex);
      if (this.started) {
        this.log.info("connection " + (connIndex + 1) + " to cluster-render");
        client.connect();
      }
    }
    return this.clients[i];
  }

  /**
   * Logs a connection's events and updates the status from them.
   * @param {Client} client
   * @param {number} connIndex connection index
   * @returns {void}
   * @this {App}
   */
  _wireClientEvents(client, connIndex) {
    const tag = connIndex ? " [connection " + (connIndex + 1) + "]" : "";
    client.on("ready", () => {
      this.log.info(
        "cluster-render ready" + tag + " (backend=" + client.backend + ")",
      );
      if (connIndex === 0) this._rebuild();
      else this._status();
    });
    client.on("disconnected", () => {
      this.log.warn(
        "cluster-render disconnected" + tag + ", client will retry",
      );
      this._status();
    });
    client.on("layer", (ref, state, reason) => {
      const key = connIndex + ":" + ref;
      const old = this.layerStates.get(key);
      this.layerStates.set(key, { state, reason });
      if (
        state === "error" ||
        ((state === "waiting" || state === "stalled") &&
          (!old || old.state !== state))
      ) {
        const widgetId = this._widgetOf(connIndex, ref);
        this.log.warn(
          "layer " +
            ref +
            tag +
            (widgetId ? " (" + widgetId + ")" : "") +
            " " +
            state +
            (reason ? ": " + reason : ""),
        );
      }
      this._statusSoon();
    });
    client.on("target", (name, state, holder, reason, guideOff, disabled) => {
      if (name !== this.target) return;
      this.targetState = { state, holder, reason, disabled: !!disabled };
      this.log.info(
        "target " +
          name +
          tag +
          " " +
          state +
          (holder ? " (holder " + holder + ")" : "") +
          (reason ? ": " + reason : "") +
          (disabled
            ? " (disabled by cluster-render's mapping guard: two strikes; as root: /var/opt/cluster-render/current/cluster-render -c /var/opt/cluster-render/current/cluster-render.conf guard-reset)"
            : ""),
      );
      this._statusSoon();
    });
    client.on("refused", (operation, ref, reason) => {
      const widgetId = this._widgetOf(connIndex, ref);
      this.log.warn(
        "refused " +
          operation +
          " on " +
          ref +
          tag +
          (widgetId ? " (" + widgetId + ")" : "") +
          ": " +
          reason,
      );
      // an asset format this cluster-render doesn't know: Miku's ETC2 atlases (etc2rgba) need 0.5.9 or later
      const hint = operation === "asset" && /format/i.test(reason) ? " (ETC2 needs cluster-render 0.5.9 or later)" : "";
      if (!this.refused) this.refused = (widgetId || operation) + ": " + reason + hint; // the first one, until the next rebuild
      // the widget knows it can't draw (Miku doesn't zoom into a close-up that isn't there); a refused asset leaves
      // the cache, so the next rebuild asks again
      const state = widgetId ? this.widgets.get(widgetId) : null;
      if (state) state.refused = true;
      this.atlases.forEach((atlas, key) => {
        if (atlas.c === client && atlas.ref === ref && operation === "asset")
          this.atlases.delete(key);
      });
      this._statusSoon();
    });
    client.on("budget", (capKb, maxKb, reason) =>
      this.log.info(
        "budget" + tag + " " + capKb + "/" + maxKb + " kb/s (" + reason + ")",
      ),
    );
    client.on("status", (text) =>
      this.log.info("cluster-render status: " + text),
    );
  }

  /**
   * Connects and starts the timers and signal watches.
   * @returns {void}
   * @this {App}
   */
  start() {
    this.log.info("connecting to cluster-render at " + this.socketPath);
    this.started = true;
    this.clients.forEach((client) => client.connect());
    this.tickTimer = setInterval(
      () => this._guard("tick", () => this._tick()),
      TICK_MS,
    );
    // Auto theme: check for sunrise / sunset once a minute; the status line too
    this.themeTimer = setInterval(
      () =>
        this._guard("theme check", () => {
          if (this._themeName() !== this.themeName) this._rebuild();
          this._status();
        }),
      THEME_CHECK_MS,
    );
    this.statusTimer = setInterval(
      () => this._guard("status", () => this._status()),
      STATUS_MS,
    );
    this._status();
    this._startDme();
    this._startNav();
    this._startMedia();
  }

  /**
   * Stops the timers and watches and closes the connections.
   * @returns {void}
   * @this {App}
   */
  stop() {
    clearInterval(this.tickTimer);
    clearInterval(this.themeTimer);
    clearInterval(this.statusTimer);
    clearInterval(this.dmeTimer);
    clearTimeout(this.statusAskT);
    if (this.navSub) this.navSub.shutdown();
    if (this.mediaSub) this.mediaSub.shutdown();
    clearTimeout(this.fontT);
    this.widgets.forEach((state) => {
      if (state.timer) clearInterval(state.timer);
    });
    this.clients.forEach((client) => client.close());
    this.atlases.clear();
  }

  /**
   * Runs fn, logging what it throws instead (see the header).
   * @param {string} what
   * @param {() => void} fn
   * @returns {void}
   * @this {App}
   */
  _guard(what, fn) {
    try {
      fn();
    } catch (err) {
      this.log.error("hud " + what + ": " + ((err && err.stack) || err));
    }
  }

  /* ---------------- status line (the center screen's first row) ---------------- */

  /* ---------------- theme, units, values ---------------- */

  /* ---------------- layers ---------------- */

  /**
   * Drops the layers and builds the layout for now again (never throws).
   * @returns {void}
   * @this {App}
   */
  _rebuild() {
    this._guard("rebuild", () => this._rebuildInner());
    this._status();
  }

  /**
   * _rebuild's work.
   * @returns {void}
   * @this {App}
   */
  _rebuildInner() {
    if (!this.client.ready) return; // the 'ready' handler calls us again
    this._layerRefs().forEach((layerRef) => layerRef.c.drop(layerRef.ref));
    this.widgets.forEach((state) => {
      if (state.timer) clearInterval(state.timer);
    });
    this.widgets.clear();
    this.sheets = [];
    this.pixelBytes = 0;
    this.layerStates.clear();
    this.refused = null;
    clearTimeout(this.statusAskT);
    this.statusAskT = null;
    this.car.setRedline(this.setting("redline"));
    const name = this._layoutName(),
      mode = this._mode();
    this.activeName = name;
    this.activeMode = mode;
    this.modeOff = false;
    if (name === "off") {
      this.problem = null;
      this.layoutTheme = null;
      this.needsBoost = false;
      this.needsVolt = false;
      this.needsPedal = false;
      this.log.info(
        "off: nothing drawn, BMW's own " +
          (this.target === "panel" ? "cluster" : "HUD") +
          " shows",
      );
      return;
    }
    let layout;
    try {
      layout = this.layouts.load(name);
    } catch (err) {
      this.problem = err.message;
      this.log.warn(
        'layout "' + name + '" unusable (' + err.message + "); showing nothing",
      );
      return;
    }
    if (mode !== "normal" && (layout.modes || []).indexOf(mode) < 0) {
      this.problem = null;
      this.layoutTheme = null;
      this.needsBoost = false;
      this.needsVolt = false;
      this.needsPedal = false;
      this.activeName = "off";
      this.modeOff = true;
      this.log.info(
        'layout "' +
          layout.name +
          '" has no ' +
          mode +
          " variant: nothing drawn, " +
          MODE_TEXT[mode] +
          " shows",
      );
      return;
    }
    this.problem = null;
    this.layoutTheme =
      layout.theme && THEMES[layout.theme] ? layout.theme : null;
    this.themeName = this._themeName();
    this.theme = THEMES[this.themeName] || THEMES.classic;
    this.log.info(
      'layout "' +
        layout.name +
        '", theme ' +
        this.theme.name +
        (this.layoutTheme ? "" : " (" + this.setting("hudTheme") + ")") +
        (mode !== "normal" ? ", " + mode + " mode" : ""),
    );
    let shown = layout.widgets
      .map((widget) => this._inMode(widget, mode))
      .filter(
        (widget) =>
          widget &&
          !(widget.toggle && !this._toggleOn(widget.toggle)) &&
          !(widget.themes && widget.themes.indexOf(this.themeName) < 0),
      );
    // a baked backdrop under the live parts (engine/backdrop.js); missing or out of date, nothing is drawn and the
    // status row says why
    if (layout.backdrop) {
      try {
        shown = useBackdrop(this, name, shown);
      } catch (err) {
        noBackdrop(this);
        this.problem = layout.name + ": " + (err instanceof Error ? err.message : err);
        this.log.warn('layout "' + name + '": ' + this.problem);
        return;
      }
    } else noBackdrop(this);
    this.needsBoost = /boost/.test(JSON.stringify(shown));
    this.needsVolt = /volt12/.test(JSON.stringify(shown));
    this.needsPedal = /throttle/.test(JSON.stringify(shown));
    // plan the layers first (a sheet's size is only known once every member is placed), then make them
    // in that order: within a class and z, cluster-render puts the newer layer on top. Small sheets
    // first; a bigger limit only when the layer budget needs it (see the header).
    const area = this.size[0] * this.size[1];
    /** @type {(entries: PlanEntry[]) => boolean} */
    const over = (entries) =>
      this._connCounts(entries).some((k) => k > LAYER_BUDGET);
    let maxPx = Math.floor(area / SHEET_AREA_FRAC),
      plan = this._plan(shown, maxPx);
    while (over(plan) && maxPx !== Infinity) {
      maxPx = maxPx * 2 >= area ? Infinity : maxPx * 2;
      plan = this._plan(shown, maxPx);
    }
    let effects = 0,
      own = 0,
      sheets = 0,
      bytes = 0,
      pixelBytes = 0;
    plan.forEach((entry) => {
      if (entry.kind === "sheet") {
        sheets++;
        bytes += entry.w * entry.h * 4;
        pixelBytes += entry.w * entry.h * IMAGE_PX_BYTES;
        this._guard("sheet " + entry.members[0].id, () =>
          this._createSheet(entry),
        );
      } else {
        if (isImage(entry.w.type)) {
          own++;
          pixelBytes += entry.w.w * entry.w.h * IMAGE_PX_BYTES;
        } else effects++;
        this._guard("widget " + entry.w.id, () => this._create(entry.w, null));
      }
    });
    const atlasBytes = this._atlasBytes();
    pixelBytes += atlasBytes;
    this.pixelBytes = pixelBytes;
    const layerCount = this._layerRefs().length,
      counts = this._connCounts(plan);
    this.log.info(
      'layout "' +
        layout.name +
        '": ' +
        shown.length +
        " widgets, " +
        this._layerCount(layerCount) +
        " (" +
        effects +
        " effects, " +
        sheets +
        " image sheets" +
        (own ? ", " + own + " own image layers" : "") +
        ")" +
        (counts.length > 1
          ? " on " + counts.length + " connections (" + counts.join(" + ") + ")"
          : "") +
        ", sheet limit " +
        (maxPx === Infinity ? "unlimited" : maxPx + " px") +
        ", whole-sheet writes " +
        bytes +
        " bytes, pixel memory " +
        mib(pixelBytes) +
        " of 32 MiB" +
        (atlasBytes
          ? " (" +
            this.atlases.size +
            " atlas" +
            (this.atlases.size > 1 ? "es" : "") +
            " " +
            mib(atlasBytes) +
            ")"
          : ""),
    );
    counts.forEach((k, connIndex) => {
      if (k > LAYER_BUDGET)
        this.log.warn(
          'layout "' +
            layout.name +
            '" needs ' +
            k +
            " layers on connection " +
            (connIndex + 1) +
            ", cluster-render draws at most " +
            LAYER_BUDGET +
            " per connection",
        );
    });
    if (pixelBytes > PIXEL_BYTES)
      this.log.warn(
        'layout "' +
          layout.name +
          '" needs ' +
          mib(pixelBytes) +
          " of pixel memory; cluster-render (0.5.4 from james10424/idrive-apps-lib) has 32 MiB for every app together, each image counted twice (16 in upstream's)",
      );
    this.statusAskT = setTimeout(() => {
      this.statusAskT = null;
      this._guard("status request", () => this.client.status());
    }, STATUS_ASK_MS);
  }

  /**
   * A widget: on its own layer (sheet null: an effect, or an image widget with "own": true), or a member of a sheet.
   * @param {Widget} widget
   * @param {?Sheet} sheet
   * @returns {void}
   * @this {App}
   */
  _create(widget, sheet) {
    const mod = widgetTypes[widget.type];
    let ref, client;
    if (sheet) {
      ref = sheet.ref;
      client = sheet.c;
    } else {
      client = this._clientAt(this._connOf(widget));
      const base = {
        target: this.target,
        klass: widget.class || "content",
        z: widget.z || 0,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
      };
      if (isImage(widget.type))
        ref = client.image(Object.assign({ iw: widget.w, ih: widget.h }, base));
      else {
        // a widget module's shader; null: it can't draw now (it said why)
        const fragmentShader = mod.shader(this, widget, this._connOf(widget));
        if (fragmentShader === null) return;
        ref = client.effect(
          Object.assign(
            {
              fs: fragmentShader,
              time: mod.time || undefined,
            },
            base,
          ),
        );
      }
      if (!ref) {
        this.log.warn('widget "' + widget.id + '": layer refused');
        return;
      }
    }
    /** @type {WidgetState} */
    const state = {
      w: widget,
      ref,
      c: client,
      ci: sheet ? sheet.ci : this._connOf(widget),
      sheet: sheet || null,
      last: null,
      lastPaint: 0,
      px: null,
    };
    this.widgets.set(widget.id, state);
    mod.create(this, widget, state);
    this._update(state, Date.now(), true);
  }

  /**
   * A "reset" setting (a bool that acts once): every widget module with a reset() puts its animation back to the
   * start, then the setting flips back off. Nothing is rebuilt.
   * @param {string} key
   * @returns {void}
   * @this {App}
   */
  _resetAnim(key) {
    if (this.ctx.settings.get(key) !== true) return;
    this.widgets.forEach((state) => {
      const mod = widgetTypes[state.w.type];
      if (mod.reset)
        this._guard("widget " + state.w.id, () => mod.reset(this, state));
    });
    this.log.info("animations reset (" + key + ")");
    this.ctx.settings.set(key, false);
  }

  /**
   * The 20 Hz tick: the rpm, the shift flash, and every widget without its
   * own timer.
   * @returns {void}
   * @this {App}
   */
  _tick() {
    const now = Date.now();
    if (this._freshData) this._freshData();
    this._smoothRpm(now);
    if (!this.client.ready || this._offScreen()) return;
    // shift light: blink the whole bar at 8 Hz once the rpm reaches the redline
    const rpm = this._raw("rpm");
    const flashing = isNum(rpm) && rpm >= this.setting("redline") - FLASH_RPM;
    this.flash = flashing ? Math.floor(now / FLASH_HALF_MS) % 2 === 0 : false;
    this.widgets.forEach((state) => {
      if (!state.timer)
        this._guard("widget " + state.w.id, () =>
          this._update(state, now, false),
        );
    });
  }

  /**
   * Our display isn't showing us (another app or BMW holds it, or it is parked behind BMW's content): widgets
   * don't update. cluster-render keeps our layers meanwhile, so the next update sends only what changed since.
   * Before cluster-render has said anything about the target, it counts as shown.
   * @returns {boolean}
   * @this {App}
   */
  _offScreen() {
    const target = this.targetState;
    return !!target && target.state !== "shown" && target.state !== "lingering";
  }

  /**
   * Sends a widget's new values (uniforms or pixels) when they changed;
   * force: always.
   * @param {WidgetState} state
   * @param {number} now
   * @param {boolean} force
   * @returns {void}
   * @this {App}
   */
  _update(state, now, force) {
    widgetTypes[state.w.type].update(this, state, now, force);
  }
}

/**
 * Adds a file's methods to HudApp, as class methods are (not enumerable).
 * @param {Record<string, Function>} methods
 */
function mixin(methods) {
  Object.keys(methods).forEach((k) =>
    Object.defineProperty(HudApp.prototype, k, {
      value: methods[k],
      writable: true,
      configurable: true,
      enumerable: false,
    }),
  );
}
[
  require("./plan"),
  require("./status"),
  require("./modes"),
  require("./assets"),
  require("../car/signals"),
  require("../car/route"),
  require("../car/assist"),
  require("../car/values"),
  require("../car/lamps"),
  require("../car/tokens"),
].forEach(mixin);

module.exports = HudApp;
