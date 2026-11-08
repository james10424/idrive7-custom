'use strict';
/**
 * The drawing engine, shared by every bimmer-lab app that draws through cluster-render
 * (robertnisipeanu/idrive-apps, native/cluster-render): it connects, builds the active layout's layers in
 * the active theme (one effect layer per shader widget, the image widgets packed into sheets, below), and
 * keeps live widgets updated from the kit's car.js.
 * Started by an app's main.js with the kit's ctx (settings, signals, log, spec, dataDir).
 * It lives in the repo's shared/ folder; app.json "shared" ships it with each app.
 *
 * Which display: app.json config.target, "hud" (800x480, the windshield HUD; the default) or
 * "panel" (1920x720, the whole instrument cluster, drawn over BMW's own gauges).
 * config.statusName names it on the status row ("HUD", "Cluster").
 * Which layout: with the "byMode" setting on and the car's drive mode known (FES
 * statusFESVehicleDynamicSwitchHMI), the "inComfort" / "inSport" / "inEco" setting; otherwise "hudLayout".
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
 * Layer packing (Nov 5 2026): cluster-render draws at most 8 layers per client connection (its
 * CompositorLimits.per_client; 32 across all clients; a 9th is refused with "too many layers"), which the car
 * photos showed as a theme's shaders plus the first few text widgets. So the image widgets (text, scale, stripe, badge, gridlabels, icon, swatchimg) are
 * packed into SHEETS, one image layer per sheet, instead of one layer each. Widgets are grouped by
 * (class, z) and placed in file order: a widget goes into the first sheet of its group opened after every
 * earlier layer or widget its rect intersects (so an image widget never clobbers one it overlaps, and
 * file order still decides what is on top) AND whose union box with it stays within the sheet size limit,
 * else a new sheet is opened. A sheet's rect is the union box of its members (iw/ih that size). On create
 * every member is painted into a local buffer and the sheet is sent whole once (a 1920x720 RGBA whole write
 * is 5,529,600 bytes, under the 5,529,664 message limit; the client keeps its own whole copy); after that
 * every member update is a dirty rect of the sheet, translated by the sheet's offset (_blit; gridlabels
 * keeps its small-rects path). Effect widgets are one layer each, as before. An image widget with
 * "own": true gets its own layer as before (the calibration probes use it to count how many layers the car
 * draws).
 * Sheet size vs layer count: a rebuild re-sends every sheet whole, through the car's upload budget (floor
 * 2000 KB/s, ceiling 5500, the HUD gets at most half), so sheets are kept small: the limit starts at a
 * quarter of the target area (345,600 px on the panel, 96,000 on the HUD). If that needs more than
 * LAYER_BUDGET (8) layers in all (effects + own + sheets), the limit is doubled and the layout re-planned,
 * up to unlimited; if even unlimited needs more than 8, a warning says so and the layout is drawn anyway.
 * The rebuild log line names the layout, widget and layer counts, the limit used and the bytes of the
 * whole-sheet writes; the status row names the layer count, not the widget count; and two seconds after a
 * rebuild cluster-render's own status text is asked for and logged.
 *
 * Widget types (hud/layouts/*.json, or <data>/layouts/ overrides, see layouts.js):
 *   text      image layer; template tokens below, a font from hud/fonts, colour role
 *   scale     image layer; the shift bar's rpm numbers (0 .. bar max / 1000), evenly spread
 *   stripe    image layer; the M tricolour stripe
 *   shiftbar  effect layer; shaders.js shiftbar, lit by rpm, zones from the redline
 *   arc       effect layer; shaders.js arc, lit by a signal between min and max
 *   revbar    effect layer; shaders.js revbar, the G20-style slanted rev bar (Redline layout):
 *             "barH" bar height, "top" room for the marks above it, "slant" px, "over" rpm past the
 *             redline's thousand the scale runs to (1000: a 7000 redline gives 0..8)
 *   lights    effect layer; shaders.js lights, shift lights filling from "from" rpm (3000) up to the shift point
 *   badge     image layer; a rounded tag with text: "tone" verdict (the last shift's grade colour) or cold
 *   fill      effect layer; a solid colour (role "color", default "bg") over the whole widget, with an
 *             optional see-through "hole": [x, y, w, h] in target px, cut only while the bool setting
 *             "holeWhen" is on (the cluster's map window), shrunk by "holeInset" px on every side (6) with
 *             "holeRadius" px corners (28), so BMW's own cluster doesn't peek out at the window's corners.
 *             Opaque fill hides BMW's gauges under it.
 *   box       effect layer; a framed box: "fill" and "line" roles, "border" px, "radius" px, and a
 *             header strip "head" px tall in role "headColor" (its label is a text widget on top)
 *   mdash     effect layer; the M theme's whole backdrop (shaders.js mdash): "card" [x, yBottom, rBottom, rTop] (the
 *             left card, traced off the M8 photo: outer edge x, bottom y, the big round at the bottom outer corner, the
 *             rounding where the top curve meets the outer edge; the right card is its mirror), "cardTop" [a, b, c] (the
 *             card's top edge, y = a x^2 + b x + c), "cardCutR" [cx, cy, r] (the right card's lower outer corner cut on
 *             that circle, in the mirrored left frame), "cardFill" 0..1 (grey level, 0 = black: outline only), "blade" { xm, ym,
 *             kTop, kBot, round } (the left rev blade's outer edge, as mtach; the card ends "bladeGap" px before it),
 *             "line" [x0, y, x1, cap], "tyres" [cx, cy, scale] (the tyre block's car glyph and dividers; the eight
 *             readouts are text widgets with {{tyreP:FL}} .. {{tyreT:RR}} and {{u:pressure}}), "gaugeL" / "gaugeR" { cx, cy, r, (a dial as the M8's: a thin glass bracket whose outer edge is the circle cx, cy, r, lit from the bottom up to the value, drawn over the card; the right one is the left one's mirror)
 *             signal, min, max }, "mark" [x, y, scale], "segbars" [{ x, y, w, h, max, signal } x up to 4] (the
 *             setup level bars, "segSlant" px; the segment at round(signal) is red). Positions in target px.
 *   mtach     effect layer; the M rev bar: "side" left|right, "max" rpm, and in target px for the LEFT bar
 *             "y0" (0 rpm), "y8" (max), "ym" (the bend), "xm" (outer edge x at the bend; the right bar gives
 *             its own, mirrored), "kTop" / "kBot" (x per y px above / below the bend), "round", "wBot" / "wTop" / "wBend"
 *   sdash     effect layer; the whole Sport theme (shaders.js sdash): "geo" [yTop, yBend, yBottom, xBend] and
 *             "k" [above, below, round] for the left bracket's outer line (the right one is mirrored), "band"
 *             width, "inner" (the inner line's distance from the outer one), "scale" [y of 0, y of the top mark],
 *             "ticks" [speed, rpm], "rpmMax" (speed follows SPEED_SCALE), "fuelSeg" / "oilSeg" [fullX, fullY,
 *             emptyX, emptyY], "strip" [left end x, y, h, slant], "topEnd" x; the middle is black, and the map
 *             window is cut see-through while "holeWhen" is on ("hole", "holeInset", "holeRadius" as fill), with
 *             "holeCut" [topW, topH, botW, botH]: a triangle in each corner of it kept black, mirrored left / right
 *             (BMW draws bits of its own Sport view there)
 *   segbar    effect layer; "max" segments, the first round(signal) lit (e.g. "setupLevel:engine"), "slant" px,
 *             "gap" px between segments (8)
 *   icon      image layer; a line icon from icons.js ("icon": gauge, shock, wheel, cog, stack, therm, oilcan, fuel)
 *   arc also takes "start" and "sweep" in degrees (clockwise from 12 o'clock; negative = anticlockwise)
 *   grid      calibration: effect layer of lines every "step" px (brighter every "major" steps)
 *   gridlabels  calibration: image layer, "x/y" at every "step" px (only the labels are uploaded)
 *   swatch    calibration: effect layer (calibration.js SWATCH), "steps" (11) grey steps 0..1 over the top
 *             half, four dark test colours over the bottom half
 *   swatchimg calibration: image layer, the identical picture painted into pixels (calibration.js
 *             swatchImage), so a photo of the two strips shows how the effect and image paths differ
 *   atext     effect layer (shaders.js atext): text drawn by the GPU from a glyph atlas, the probe for the path
 *             that needs no pixel writes. The font's glyphs go up once per connection as an R8 asset (one byte a
 *             pixel, not a layer, shared by every atext widget on that font); the widget is "cells" equal cells
 *             across its width ("w" / cells wide each; the glyphs keep their shape when w = cells x the font's
 *             widest advance and h = its cell height, logged at creation), and a new value is one uniform
 *             message of glyph codes. "text" tokens as text, "font", "color" role, "align" left | right | center.
 *             Up to 32 cells; only the characters the font has.
 * Any image widget: "own": true gives it its own image layer instead of a place in a packed sheet (above).
 * Any widget: "conn": 0..3 puts its layer (or its sheet) on that connection to cluster-render. The 8-layer limit
 *   is per connection, so a second socket from the same app gets another 8 (DukeAPenguin saw 28 layers over four
 *   sockets on his car, Nov 5 2026; the calibration grids probe it here: L5..L16 on connections 2..4). 0 (the
 *   default) is the app's own connection; a layout never asks for more than it needs, each extra one is opened
 *   on first use and named <app id>_<n>. Sheets never span connections.
 * Pixel memory: cluster-render has 16 MiB for every app's images together and counts each image twice
 *   (Compositor::add_image; a layer past it is refused with "the service's pixel memory is full"), so every
 *   image layer costs w*h*8 bytes. The rebuild log and the status row say what a layout costs.
 * Text and badge updates send only the one rectangle around the pixels that changed since the last paint
 *   (changes() below, after PenguinDukeYDAuto/idrive7-EVAHUD's eva_canvas.js, MIT): a 3-digit readout
 *   that goes 123 -> 124 sends its last digit, not the widget.
 *   boxes     effect layer; the GT3 dash's frame in ONE layer (shaders.js boxes; the car draws only a few effect
 *             layers): the background (role "color", default "bg") with the optional map "hole" as fill, and up to
 *             12 framed boxes "boxes": [{ id, x, y, w, h (target px), head (header strip px), border (2), radius
 *             (0), headColor "accent" (else the "head" role), toggle }]. Roles "fill" (panel), "line", "head",
 *             "accent" for all of them; the labels are text widgets on top. Sent as array uniforms (vec4 x 12).
 * Any widget: "toggle": "<bool setting>" hides it when that setting is off, "!<setting>" when it is on,
 * "<choice setting>=<value>" shows it only while that choice is picked (also with "!");
 * "themes": [...] shows it only in those themes. Text "color2": a second role, the colour at the bottom
 * of the box (a top-to-bottom gradient, the chrome look). Text: "hotWhen": "now" turns it the shift red
 * at the shift point; "coldWhen": "cold" turns it blue while the cold guard lowers the shift point.
 * scale: "over" as revbar; "redFrom": true draws the numbers from the redline on in red.
 * lights: "count" (12), "from" rpm (3000) where the first light comes on, "tail" (0): the last "tail" lights are blue
 *   (the GT3 look); "round": true for dots;
 * "off" the alpha of an unlit light (0.14).
 * Text "colorBy": "verdict" colours it by the last shift's grade. Text "near": ["speed" | "rpm", i] turns it
 * "nearColor" (fg) while scale label i is the one nearest the value (BMW lights up the label by the needle).
 *
 * rpm is smoothed (a 120 ms filter, and the readout moves in 50 rpm steps only when it changes by 40 or
 * more), so idle wobble doesn't show, as on BMW's own tach. Shift scoring uses the raw rpm.
 * Boost: FES displayBoostPressure while it's valid, else (app.json config.dme) the engine unit over
 * read-only UDS, absolute pressure minus outside air pressure, as cauliflowermossgrape's car_vitals does.
 *
 * Text tokens: {{speed}} {{u:speed}} {{oil}} {{coolant}} {{boost}} {{u:boost}} {{rpm}}
 * {{gear}} (P / R / N, D3 / S3 / M3 by the shifter programme, or just 3 when the selector position is unknown), {{gearnum}} (3, or P / R / N)
 * {{spd:<i>}} (speed scale label i of SPEED_SCALE: 0..200 mph, 0..320 km/h) {{range}} {{u:distLc}} (mi, km) {{ambient}} (outside, signed: +75) {{u:speedLc}} (mph, km/h) {{ampmLc}} (am, pm) {{torque}} {{u:torque}} (lb-ft, Nm) {{torquePct}} {{powerPct}} (% of config.engine's peak) {{boostHi}} {{boostMid}}
 * (gauge labels for 1.4 / 0.7 bar in the display unit) {{stage}} (P R N, D / S / M by the shifter programme) {{gearInD}} (gear number while in D) {{mode}} (COMFORT, SPORT, SPORT PLUS, SPORT INDIVIDUAL, ECO PRO, ...)
 * {{temp:<deg C>}} (that temperature in the display unit, °F rounded to 10, for gauge labels) {{setup:engine|chassis|steering|gearbox}} (what that part is set to in the drive mode now)
 * {{time}} {{ampm}} {{u:temp}} (°F / °C) {{gLat}} {{gLong}} (g, 2 decimals) {{signal:<car.data() key>}} (raw, 1 decimal).
 * The car ahead (de.bmw.dass.GapVehicleAhead; "--" without a car measured or data older than 3 s): {{accGap}} the gap in m / ft
 * ({{u:gap}}), from GapVehicleDrivingAhead gapVehicleDrivingAhead while its status says a car is measured (an X3 sends only
 * this one, once a second, 253 with nothing measured; DataFrontVehicle frontVehicleGapX when the car sends that), {{accRel}}
 * its speed against ours in km/h / mph ({{u:rel}}, minus = closing; "--" while we stand still): DataFrontVehicle frontVehicleSpeedX when sent,
 * else the gap's rate of change, smoothed. {{accSet}} the set speed BMW's HUD shows (DisplayDataServer cruiseCtrlSpeedHUD).
 * The catalog gives no units: app.json config.acc { gap (raw -> m), rel (raw -> km/h), set } is raw * factor + offset
 * (factor 1, offset 0 until calibrated on the car). A text widget's "needs": "<token>" draws nothing while that token is "--".
 * Pedals and 12 V (app.json config.pedals, the interfaces also in its "signals"): {{throttle}} %: with config.pedal.source "obd"
 * OBD PID 0x49 from the engine unit (config.dme.pedal, every 250 ms while shown; config.pedal.obdRange [at rest, flat out] maps
 * it to 0..100), else powertrain.AcceleratorPedal actualValueAngleAcceleratorPedal * config.pedal.factor (0.025) while its
 * qualifier says valid (on an X3 that value jumped about during a slow press, Nov 7 2026: its high byte looks like the
 * message's alive counter, so the message seems misdecoded), {{volt12}} the
 * 12 V system in V (OBD PID 0x42 from the engine unit, config.dme.volt, asked every 2 s while a shown widget uses it);
 * {{batt12}} the 12 V battery's charge, % (vehicle.CDS statusBattery2 conditionBatteryChargingCondition * config.battery.factor, 1
 * by default, 255 = none; logged raw on change to check the scaling).
 * segbar signals "throttle10" (0..10) and "brake10": while the brake lights are on (body.Light controlFunctionBrakeLight, all
 * the car gives of the brake), how hard the car slows on a log scale, 10 * ln(1 + a / 0.05 g) / ln(1 + 1 g / 0.05 g) (0.1 g
 * about 4, 0.3 g 6, 0.6 g 8, 1 g 10), at least 1; 10 without a deceleration reading.
 * Redline (shift_score.js): {{rpm10}} (rpm to 10) {{shiftAt}} {{lastShift}} {{lastGears}} (4 > 5)
 * {{verdict}} {{shiftPrompt}} (SHIFT at the shift point) {{coldNote}} (only while the oil is cold).
 * Units follow the "units" setting: us = mph, °F, psi; metric = km/h, °C, bar.
 *
 * Boost is a PUSH signal, not a diagnostic poll: tracing cauliflowermossgrape's
 * car_vitals showed its boost reading is de.bmw.infotainment.drivingexcitement.FES /
 * statusSwitchDriveDynamicSport2.displayBoostPressure, factor 0.01, offset 0,
 * invalid 255. car_vitals itself treats that field as unreliable on some cars, so
 * whether this X3 fills it is checked on the first drive. Reported here in bar.
 *
 * Never throws out of a timer or event: the kit turns an uncaught exception into an
 * app exit, and on the car a second unexpected exit uninstalls the app.
 */
const fs = require('fs');
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client.js');
const Layouts = require('./layouts');
const { THEMES, M_STRIPE, LIGHTS, VERDICT, color } = require('./hud_themes');
const ShiftScore = require('./shift_score');
const sun = require('./sun');
const textRaster = require('./hud_text');
const { paintIcon } = require('./icons');
const shaders = require('./shaders');
const calibration = require('./calibration');
const Car = require('./kit/car');

const BOOST_SCALE = { factor: 0.01, offset: 0, invalid: 255 }; // see header comment
// the widget types drawn as pixels (image layers, packed into sheets unless "own": true); the rest are shaders
const IMAGE_TYPES = { text: true, scale: true, stripe: true, badge: true, gridlabels: true, icon: true, swatchimg: true };
const STATUS_ASK_MS = 2000;      // after a rebuild: ask cluster-render for its own status text
const LAYER_BUDGET = 8;          // cluster-render's limit per client connection (CompositorLimits.per_client; confirmed on the car Nov 5 2026)
const MAX_CONN = 4;              // connections a layout may ask for ("conn"): 32 layers service-wide / 8 per connection
const PIXEL_BYTES = 16 * 1024 * 1024;   // cluster-render's pixel memory for every app's images together (CompositorLimits.pixel_bytes)
const SHEET_AREA_FRAC = 4;       // the first sheet size limit: 1/4 of the target area (see the header)
const TICK_MS = 50;              // 20 Hz: shift bar and gauges
const TEXT_MS = 200;             // text re-draws at most 5 times a second (what BMW's own readouts do)
const DEFAULT_LOCATION = { lat: 35.2271, lon: -80.8431 }; // Charlotte, NC: for the Auto theme's sunset
const TARGET_SIZES = { hud: [800, 480], panel: [1920, 720] };
const MODE_KEY = { comfort: 'inComfort', sport: 'inSport', eco: 'inEco' };
const TYRE_CORNERS = ['FL', 'FR', 'RL', 'RR'];
// the car's display units (Vehicle statusNewCurrentUnitsStatusExt, as BMW's own x_call reads them; car_vitals, MIT)
const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F' };
const PRESS_TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
const unitName = (map, v) => map[v] || (Object.values(map).indexOf(v) >= 0 ? v : null);
// MDrive dataDisplayGearbox.displayProgramGearbox: the programme the cluster shows next to the gear (car_vitals, MIT)
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };
const MODE_NAME = { comfort: 'Comfort', sport: 'Sport', eco: 'Eco Pro' };
// BMW's route guidance (oap-sdk navigation/guiding: ACTIVE, INACTIVE, CALCULATING_ROUTE)
const GUIDANCE = { iface: 'de.bmw.infotainment.navigation.guiding.Guidance', instance: 'Main_Instance' };
const GUIDANCE_STATE = { INACTIVE: 0, CALCULATING_ROUTE: 1, ACTIVE: 2 };
// DisplayDataServer functionalLibraryData enums (the car's SOME/IP catalog, someip-interfaces.json): what BMW's HUD
// draws for the driver assistance systems. The car may send the names or the numbers.
const LDM_SYM = { LDM_SYM_NONE: 0 };                                  // ldmSym: anything else is a symbol (ACC, DCC, STA, ...)
const LDM_COLOR = { LDM_OFF: 0 };                                     // ldmSymColor: active, standby, critical, ...
const ACC_SYM = { LDM_CAR_OFF: 0 };                                   // activeCruiseControl.symbolACC: the car ahead
const ACC_BARS = { LDM_OFF: 0 };                                      // activeCruiseControl.barsColorACC: the distance bars
const STA_WHEEL = { LDM_STW_OFF: 0, LDM_STW_GREY: 1, LDM_STW_GREEN: 2, LDM_STW_YELLOW: 4, LDM_STW_RED: 8 };
// GapVehicleAhead qualifiers: DataFrontVehicle's (2 = no data) and GapVehicleDrivingAhead's (6 error, 14 not available, 15 not filled)
const AHEAD_Q = { EVENT_DATA_AVAILABLE: 0, EVENT_DATA_AVAILABLE_REDUCED: 1, EVENT_DATA_NOT_AVAILABLE: 2 };
const AHEAD2_Q = { FUNKTION_VERFUEGBAR: 1, FUNKTION_VERFUEGBAR__MINUS__EINGESCHRAENKT: 3, FUNKTION_MELDET_FEHLER: 6, FUNKTION_NICHT_VERFUEGBAR: 14, SIGNAL_UNBEFUELLT: 15 };
// GapVehicleDrivingAhead statusMeasurementVehicleDrivingAhead: 1..4 is a car measured (new, measured, partly hidden, predicted)
const AHEAD2_MEASURED = { KEIN_ELEMENT_GEMESSEN: 0, NEUES_ELEMENT__GEMESSEN: 1, ELEMENT__GEMESSEN: 2, ELEMENT__GEMESSEN__MINUS__TEILWEISE_VERDECKT: 3, ELEMENT_PRAEDIZIERT: 4 };
const REL_TAU_MS = 1500;          // the smoothing of a relative speed worked out from the gap
const BRAKE_LIGHT = { INIT: 0, OFF_BL: 1, ON_BL: 2, SIGNAL_UNGUELTIG: 3 };
const PEDAL_OK = { SIGNALWERT_IST_GUELTIG_UND_ABGESICHERT_UND_PLAUSIBILISIERT: 1 };   // AngleAcceleratorPedal's qualifier: valid
const VOLT_MS = 2000;             // the 12 V reading's interval
const PEDAL_MS = 250;             // the OBD pedal reading's interval
const BRAKE_G0 = 0.05, BRAKE_GMAX = 1.0;   // the brake bar's log scale: deceleration in g where it bends, and where it is full
const BRAKE_TAU_MS = 150;         // the deceleration's smoothing for the brake bar
const MODE_TEXT = { cruise: "BMW's driver assistance", nav: "BMW's guidance", cruiseNav: "BMW's guidance and driver assistance" };
/** An enum field as a number: its wire number, or its name looked up in items (unknown names: null). */
function enumNum(v, items) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return null;
    if (/^\d+$/.test(v.trim())) return Number(v.trim());
    return items[v.trim()] !== undefined ? items[v.trim()] : -1;      // a name we don't know is some non-off value
}
const FRESH_MS = 3000;
// BMW's speed scale: even steps to 120 mph (180 km/h), then wider ones to 200 mph (320 km/h)
const SPEED_SCALE = { us: [0, 20, 40, 60, 80, 100, 120, 160, 200], metric: [0, 30, 60, 90, 120, 150, 180, 250, 320] };
/** speed (display unit) -> 0..1 along a scale of evenly spaced labels */
function scaleFrac(v, marks) {
    if (!(v > 0)) return 0;
    for (let i = 1; i < marks.length; i++) if (v <= marks[i]) return (i - 1 + (v - marks[i - 1]) / (marks[i] - marks[i - 1])) / (marks.length - 1);
    return 1;
}           // a boost reading older than this is not used

/**
 * The drive mode from FES statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience: names or wire
 * numbers (cauliflowermossgrape's live_data signals.js, MIT): 1 Sport, 2 Sport+, 3 Sport individual,
 * 4 Comfort, 5 Comfort+, 6 Comfort individual, 7 Eco Pro, 8 Eco Pro+, 9 Eco Pro individual, 10 Adaptive.
 */
/** The mode's variant: 'plus' (Sport+ / Comfort+ / Eco Pro+: wire 2, 5, 8, or PLUS / EXPERT in the name), 'individual'
 *  (wire 3, 6, 9, or INDIVID in the name), else null. */
function driveVariantOf(raw) {
    const v = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (typeof v === 'number') return v === 2 || v === 5 || v === 8 ? 'plus' : v === 3 || v === 6 || v === 9 ? 'individual' : null;
    if (typeof v !== 'string') return null;
    return /PLUS|EXPERT/i.test(v) ? 'plus' : /INDIVID/i.test(v) ? 'individual' : null;
}

/** The M theme's setup rows: what each part is set to in a drive mode (they follow the mode buttons). */
const SETUP = {
    eco:       { engine: 'EFFICIENT', chassis: 'COMFORT', steering: 'COMFORT', gearbox: 'EFFICIENT' },
    comfort:   { engine: 'COMFORT', chassis: 'COMFORT', steering: 'COMFORT', gearbox: 'COMFORT' },
    sport:     { engine: 'SPORT', chassis: 'SPORT', steering: 'SPORT', gearbox: 'SPORT' },
    sportplus: { engine: 'SPORT PLUS', chassis: 'SPORT', steering: 'SPORT', gearbox: 'SPORT PLUS' },
    // the car reports only that an Individual setup is on, not what each part is set to (no signal found yet)
    individual: { engine: 'INDIVIDUAL', chassis: 'INDIVIDUAL', steering: 'INDIVIDUAL', gearbox: 'INDIVIDUAL' },
};
const SETUP_LEVEL = { EFFICIENT: 1, COMFORT: 1, SPORT: 2, 'SPORT PLUS': 3, INDIVIDUAL: 0 };

function driveModeOf(raw) {
    let v = raw;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
    if (typeof v === 'number') {
        if (v >= 1 && v <= 3) return 'sport';
        if (v >= 7 && v <= 9) return 'eco';
        if ((v >= 4 && v <= 6) || v === 10) return 'comfort';
        return null;
    }
    if (typeof v !== 'string') return null;
    const u = v.trim().toUpperCase();
    if (u.indexOf('SPORT') === 0) return 'sport';
    if (u.indexOf('ECO') === 0) return 'eco';
    if (u.indexOf('COMFORT') === 0 || u.indexOf('ADAPTIVE') === 0) return 'comfort';
    return null;
}

function rgb(c) { return [c[0] / 255, c[1] / 255, c[2] / 255]; }

/**
 * The one rectangle around what differs between two RGBA images of the same size, with its pixels, or null
 * when they are the same (after idrive7-EVAHUD's eva_canvas.js, MIT). The link is what is short, not the CPU:
 * comparing a widget costs about a tenth of painting it.
 */
function changes(was, now, w, h) {
    const row = w * 4;
    const sameRow = (y) => now.compare(was, y * row, (y + 1) * row, y * row, (y + 1) * row) === 0;
    const samePx = (o) => now[o] === was[o] && now[o + 1] === was[o + 1] && now[o + 2] === was[o + 2] && now[o + 3] === was[o + 3];
    let top = 0;
    while (top < h && sameRow(top)) top++;
    if (top === h) return null;
    let bottom = h - 1;
    while (sameRow(bottom)) bottom--;
    let left = w, right = -1;
    for (let y = top; y <= bottom; y++) {
        if (sameRow(y)) continue;
        const o = y * row;
        for (let x = 0; x < left; x++) if (!samePx(o + x * 4)) { left = x; break; }
        for (let x = w - 1; x > right; x--) if (!samePx(o + x * 4)) { right = x; break; }
    }
    const rect = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    const px = Buffer.allocUnsafe(rect.w * rect.h * 4);
    for (let y = 0; y < rect.h; y++) now.copy(px, y * rect.w * 4, (top + y) * row + left * 4, (top + y) * row + (right + 1) * 4);
    return { rect, px };
}
function rgba(c) { return [c[0] / 255, c[1] / 255, c[2] / 255, (c[3] === undefined ? 255 : c[3]) / 255]; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }

class HudApp {
    constructor(ctx) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.config = (ctx.spec && ctx.spec.config) || {};
        this.location = this.config.location || DEFAULT_LOCATION;
        // HUD_CLUSTER_SOCKET: the Mac bench's fake cluster-render; never set on the car
        this.socketPath = process.env.HUD_CLUSTER_SOCKET || this.config.socketPath || DEFAULT_PATH;
        this.clients = [];               // the connections to cluster-render: [0] the app's own, more for "conn" widgets
        this.started = false;
        this.layerStates = new Map();    // "<conn>:<ref>" -> { state, reason } from cluster-render
        this.client = this._clientAt(0);
        this.target = TARGET_SIZES[this.config.target] ? this.config.target : 'hud';
        this.size = TARGET_SIZES[this.target];
        this.label = this.config.statusName || 'HUD';
        this.layoutTheme = null;         // the active layout's own theme, if it has one
        this.layouts = new Layouts(ctx.dataDir, this.log, this.size);
        this.widgets = new Map();        // widget.id -> { w, ref, sheet | null, last, lastPaint }
        this.sheets = [];                // the packed image layers: { ref, klass, z, x, y, w, h, members, buf }
        this.boostFes = null; this.boostFesAt = 0;    // bar, from the sport display signal
        this.boostDme = null; this.boostDmeAt = 0;    // bar, from the engine unit (fallback)
        this.needsBoost = false;         // a shown widget uses boost (the engine unit is only asked then)
        this.driveMode = null;           // 'comfort' | 'sport' | 'eco', once the car has said
        this.driveVariant = null;        // 'plus' (Sport+ / Comfort+ / Eco Pro+), 'individual', or null
        this.navActive = false;          // BMW's route guidance is on (the HUD shows its own guidance then)
        this.navRaw = undefined;         // the last guidanceState as the car sent it, for the log
        this.assistActive = false;       // BMW's HUD shows its driver assistance block (ACC, DCC, STA)
        this.assistRaw = undefined;      // the last summary of it, for the log
        this.activeMode = 'normal';      // the HUD mode the layers were built for
        this.ahead = null;               // the car ahead, raw: { gapX, gapY, speedX, speedY, q, at } (DataFrontVehicle)
        this.ahead2 = null;              // { gap, q, measured, at } (GapVehicleDrivingAhead)
        this.relFromGap = null;          // km/h, the gap's smoothed rate of change ({ v, gapM, at })
        this.pedal = null;               // { raw, at }: the accelerator pedal as sent, while valid
        this.brakeOn = null;             // the brake lights (true / false), null until the car says
        this.volt12 = null; this.volt12At = 0;   // V, the 12 V system from the engine unit
        this.needsVolt = false;          // a shown widget uses volt12 (the engine unit is only asked then)
        this.pedalLogged = 0;
        this.pedalObd = null; this.pedalObdAt = 0; this.pedalObdLogged = null;   // %, the pedal from the engine unit (OBD PID 0x49)
        this.needsPedal = false;         // a shown widget uses the throttle (the engine unit is only asked then)
        this.decelF = null; this.decelAt = 0;   // g, the smoothed deceleration for the brake bar
        this.carOffsetMin = null;        // the car's time zone, minutes from UTC, from the time the cluster shows
        this.battRaw = null; this.battAt = 0;   // the 12 V battery's charge condition as sent
        this.aheadLogged = '';
        this.accSetRaw = null;           // cruiseCtrlSpeedHUD as sent
        this.aheadLogAt = 0;
        this.carUnits = { press: null, temp: null, psiSeen: false };   // the car's display units, for the TPMS values
        this.program = null;             // 'S' / 'M' from the MDrive gearbox display, else null (D)
        this.fuelL = null; this.rangeKm = null; this.ambient = null;   // KombiIF tank / range, outside temperature
        this.tyres = { p: {}, t: {} };                                  // TPMS pressure (bar) and temperature (C) per corner FL FR RL RR
        this.activeName = null;          // the layout shown now ('off' = nothing)
        this.pixelBytes = 0;             // what the layout's image layers and glyph atlases cost of cluster-render's pixel memory
        this.atlases = new Map();        // "<conn>:<font>" -> { ref, c, ci, cols, rows, cellW, cellH, chars, bytes }: R8 assets, kept across rebuilds
        this.targetState = null;         // { state, holder, reason } of our target
        this.rpmF = null; this.rpmShown = null; this.lastTickT = 0;
        this.themeName = null;
        this.flash = false;
        this.problem = null;             // why nothing shows (a bad layout), for the status line
        this.statusListeners = [];
        this.lastStatus = null;

        this._setupVehicleData();
        this.layouts.onChange(() => this._rebuild());
        ctx.settings.onChange((key) => { if (key !== 'demo') this._rebuild(); else this._status(); });
    }

    /** A setting's value, or its default when the saved value isn't one the schema allows. */
    setting(key) {
        const s = this.ctx.settings.item(key);
        const v = this.ctx.settings.get(key);
        if (!s) return v;
        const ok = s.type === 'bool' ? typeof v === 'boolean'
            : s.type === 'choice' ? (s.options || []).some((o) => o[0] === v)
                : s.type === 'number' ? isNum(v) && (!s.steps || s.steps.indexOf(v) >= 0) : true;
        return ok ? v : s.default;
    }

    _setupVehicleData() {
        const extra = {
            // fuel and range (cauliflowermossgrape's live_data, MIT): litres (255 = none) and km (4095 = none)
            'de.bmw.infotainment.KombiIF': {
                // the local time the cluster shows: its offset from UTC is the car's time zone (the app's own clock is UTC
                // on the car, so new Date() read 5 h ahead in Toronto, Nov 2026); follows summer time and the car's setting
                statusShowTimeDate: (v) => this._onCarClock(v),
                statusRangeTankStatus: (v) => {
                    const f = v && v.fluidLevelFuelTank, r = v && v.range;
                    this.fuelL = isNum(f) && f >= 0 && f < 255 ? f : null;
                    this.rangeKm = isNum(r) && r >= 0 && r < 4095 ? r : null;
                },
            },
            // tyre pressure and temperature per corner, in the car's own display units (_tyreBar / _tyreC).
            // The car never notifies these (BMW's own x_call only ever reads them), so they are polled.
            'de.bmw.infotainment.vehicle.TPMS': {
                $pollMs: 10000,
                statusTyrePressure: (v) => TYRE_CORNERS.forEach((k) => { this.tyres.p[k] = this._tyreBar(v && v['actualValuePressureTyre' + k + 'H']); }),
                statusTyreTemperature: (v) => TYRE_CORNERS.forEach((k) => { this.tyres.t[k] = this._tyreC(v && v['actualValueTemperatureTyre' + k + 'H']); }),
            },
            // the car's display units: the TPMS reports pressure as 0.1 x raw in the car's pressure unit and temperature
            // as the car's degrees + 40 (car_vitals, MIT; a car set to psi / F showed 32 psi as 464 psi until this was read)
            'de.bmw.infotainment.vehicle.Vehicle': {
                statusNewCurrentUnitsStatusExt: (v) => {
                    const press = unitName(PRESS_UNITS, v && v.unitOfMeasurementAirPressure), temp = unitName(TEMP_UNITS, v && v.unitOfMeasurementTemperature);
                    if (press === this.carUnits.press && temp === this.carUnits.temp) return;
                    this.carUnits.press = press; this.carUnits.temp = temp;
                    this.log.info('car units: pressure ' + (press || '?') + ', temperature ' + (temp || '?'));
                },
            },
            // S / M next to the gear: the gearbox status carries no programme on some cars, the M drive display does
            'de.bmw.infotainment.misc.MDrive': {
                dataDisplayGearbox: (v) => { this.program = PROGRAMS[v && v.displayProgramGearbox] || null; },
            },
            // outside temperature: raw * 0.5 - 40 deg C, 255 = none (car_vitals, MIT)
            'de.bmw.infrastructure.EnvironmentalInformation': {
                ExteriorTemperature: (v) => {
                    const t = v && v.temperatureExterior;
                    this.ambient = isNum(t) && t !== 255 ? t * 0.5 - 40 : null;
                },
            },
            // what BMW's HUD draws for ACC / DCC / STA ("cruise" mode); only HUD apps with makeRoom list it in app.json
            'de.bmw.infotainment.displaydataserver.DisplayDataServer': {
                functionalLibraryData: (v) => this._onAssist(v),
            },
            // the car ahead (gap, its speed): notify only, so "s" in app.json; raw until calibrated (config.acc)
            'de.bmw.dass.GapVehicleAhead': {
                DataFrontVehicle: (v) => {
                    if (!v) return;
                    const num = (x) => (isNum(x) && x !== 4095 ? x : null);
                    this.ahead = { gapX: num(v.frontVehicleGapX), gapY: num(v.frontVehicleGapY), speedX: num(v.frontVehicleSpeedX),
                        speedY: num(v.frontVehicleSpeedY), q: v.qualifierEventDataFunctionFrontVehicle, at: Date.now() };
                    this._logAhead(v);
                },
                GapVehicleDrivingAhead: (v) => {
                    if (!v) return;
                    const g = v.gapVehicleDrivingAhead, m = enumNum(v.statusMeasurementVehicleDrivingAhead, AHEAD2_MEASURED);
                    this.ahead2 = { gap: isNum(g) && g < 253 ? g : null, q: v.qualifierFunctionVehicleDrivingAhead, measured: m >= 1 && m <= 4, at: Date.now() };
                    this._gapRate();
                    this._logAhead(v);
                },
            },
            // the accelerator pedal and the brake lights (config.pedals); notify only, so "s" in app.json
            'de.bmw.powertrain.AcceleratorPedal': {
                AngleAcceleratorPedal: (v) => {
                    const raw = v && v.actualValueAngleAcceleratorPedal;
                    const ok = enumNum(v && v.qualifierActualValueAngleAcceleratorPedal, PEDAL_OK) === 1;
                    this.pedal = ok && isNum(raw) ? { raw, at: Date.now() } : null;
                    // for working out config.pedal: every change, at most 5 a second, with the pedal message's other values (a
                    // slow press on the car showed the bar jumping, Nov 7 2026: wrong field or scaling)
                    const line = raw + ' virtual ' + (v && v.actualValueAngleAcceleratorPedalVirtual) + ' gradient ' + (v && v.gradientActualValueAngleAcceleratorPedal) +
                        ' (' + (v && v.qualifierActualValueAngleAcceleratorPedal) + ')';
                    if (line !== this.pedalLine && Date.now() - this.pedalLogged > 200) {
                        this.pedalLogged = Date.now(); this.pedalLine = line;
                        this.log.info('accelerator pedal raw ' + line);
                    }
                },
            },
            // the 12 V battery's charge condition (config.pedals, with the 12 V voltage)
            'de.bmw.infotainment.vehicle.CDS': {
                statusBattery2: (v) => {
                    const c = v && v.conditionBatteryChargingCondition;
                    const raw = isNum(c) && c !== 255 ? c : null;
                    if (raw !== this.battRaw) this.log.info('12 V battery charge condition raw ' + c);
                    this.battRaw = raw; this.battAt = Date.now();
                },
            },
            'de.bmw.body.Light': {
                LampExterior: (v) => {
                    const b = enumNum(v && v.controlFunctionBrakeLight, BRAKE_LIGHT);
                    this.brakeOn = b === BRAKE_LIGHT.ON_BL ? true : b === BRAKE_LIGHT.OFF_BL ? false : null;
                },
            },
            'de.bmw.infotainment.drivingexcitement.FES': {
                statusSwitchDriveDynamicSport2: (v) => {
                    const raw = v && v.displayBoostPressure;
                    if (typeof raw !== 'number' || raw === BOOST_SCALE.invalid) return;
                    this.boostFes = raw * BOOST_SCALE.factor + BOOST_SCALE.offset;
                    this.boostFesAt = Date.now();
                },
                // the HMI's sport display: power and torque in % of the car's maximum (car_vitals, MIT); 255 = none
                statusVehicleDynamicEngine: (v) => {
                    const p = v && v.displaySportEnginePower, t = v && v.displaySportEngineTorque;
                    this.sportPower = isNum(p) && p >= 0 && p <= 150 ? p : null;
                    this.sportTorque = isNum(t) && t >= 0 && t <= 150 ? t : null;
                    this.sportAt = Date.now();
                },
                statusFESVehicleDynamicSwitchHMI: (v) => {
                    const raw = v && v.actualValueModeDrivingExperience;
                    const m = driveModeOf(raw), variant = m ? driveVariantOf(raw) : null;
                    if (!m || (m === this.driveMode && variant === this.driveVariant)) return;
                    this.log.info('drive mode ' + MODE_NAME[m] + (variant ? ' ' + variant : '') + ' (' + raw + ')');
                    this.driveMode = m; this.driveVariant = variant;
                    if (this._layoutName() !== this.activeName) this._rebuild(); else this._status();
                },
            },
        };
        // the HUD modes' signal only with them; the car ahead with them or app.json config.carAhead (the cluster's Sport)
        // (the runtime spec has no "signals": the interface must also be in app.json "signals")
        if (!this._modesOn()) delete extra['de.bmw.infotainment.displaydataserver.DisplayDataServer'];
        if (!this._modesOn() && this.config.carAhead !== true) delete extra['de.bmw.dass.GapVehicleAhead'];
        if (this.config.pedals !== true) { delete extra['de.bmw.powertrain.AcceleratorPedal']; delete extra['de.bmw.body.Light']; delete extra['de.bmw.infotainment.vehicle.CDS']; }
        this.car = new Car(this.ctx, ['rpm', 'speed', 'temps', 'accel', 'gear', 'torque'], extra);
        this.car.setRedline(this.setting('redline'));
        this.score = new ShiftScore(this.car, () => ({
            redline: this.setting('redline'), shiftBefore: this.setting('shiftBefore'), coldGuard: this.setting('coldGuard'),
        }), this.log);
    }

    /**
     * Connection i to cluster-render, made on first use: 0 is the app's own (named after the app); a widget's
     * "conn" asks for 1..3, named <app id>_2 .. _4, each with its own 8 layers. Layers made before a connection
     * is up are replayed by the client when it connects.
     */
    _clientAt(i) {
        while (this.clients.length <= i) {
            const ci = this.clients.length;
            const c = new ClusterRender(ci ? this.ctx.spec.id + '_' + (ci + 1) : this.ctx.spec.id, this.socketPath);
            this.clients.push(c);
            this._wireClientEvents(c, ci);
            if (this.started) { this.log.info('connection ' + (ci + 1) + ' to cluster-render'); c.connect(); }
        }
        return this.clients[i];
    }

    _wireClientEvents(c, ci) {
        const tag = ci ? ' [connection ' + (ci + 1) + ']' : '';
        c.on('ready', () => { this.log.info('cluster-render ready' + tag + ' (backend=' + c.backend + ')'); if (ci === 0) this._rebuild(); else this._status(); });
        c.on('disconnected', () => { this.log.warn('cluster-render disconnected' + tag + ', client will retry'); this._status(); });
        c.on('layer', (ref, state, reason) => {
            const key = ci + ':' + ref;
            const old = this.layerStates.get(key);
            this.layerStates.set(key, { state, reason });
            if (state === 'error' || ((state === 'waiting' || state === 'stalled') && (!old || old.state !== state))) {
                const w = this._widgetOf(ci, ref);
                this.log.warn('layer ' + ref + tag + (w ? ' (' + w + ')' : '') + ' ' + state + (reason ? ': ' + reason : ''));
            }
            this._statusSoon();
        });
        c.on('target', (name, state, holder, reason) => {
            if (name !== this.target) return;
            this.targetState = { state, holder, reason };
            this.log.info('target ' + name + tag + ' ' + state + (holder ? ' (holder ' + holder + ')' : '') + (reason ? ': ' + reason : ''));
            this._statusSoon();
        });
        c.on('refused', (op, ref, reason) => {
            const w = this._widgetOf(ci, ref);
            this.log.warn('refused ' + op + ' on ' + ref + tag + (w ? ' (' + w + ')' : '') + ': ' + reason);
            if (!this.refused) this.refused = (w || op) + ': ' + reason;   // the first one, until the next rebuild
            this._statusSoon();
        });
        c.on('budget', (capKb, maxKb, reason) => this.log.info('budget' + tag + ' ' + capKb + '/' + maxKb + ' kb/s (' + reason + ')'));
        c.on('status', (text) => this.log.info('cluster-render status: ' + text));
    }

    start() {
        this.log.info('connecting to cluster-render at ' + this.socketPath);
        this.started = true;
        this.clients.forEach((c) => c.connect());
        this.tickTimer = setInterval(() => this._guard('tick', () => this._tick()), TICK_MS);
        // Auto theme: check for sunrise / sunset once a minute; the status line too
        this.themeTimer = setInterval(() => this._guard('theme check', () => {
            if (this._themeName() !== this.themeName) this._rebuild();
            this._status();
        }), 60000);
        this.statusTimer = setInterval(() => this._guard('status', () => this._status()), 5000);
        this._status();
        this._startDme();
        this._startNav();
    }

    /** HUD modes only on the HUD, in apps that have the "makeRoom" setting. */
    _modesOn() { return this.target === 'hud' && !!this.ctx.settings.item('makeRoom'); }

    /** BMW's route guidance on / off, for the HUD modes. */
    _startNav() {
        if (!this._modesOn()) return;
        Promise.resolve().then(() => this.ctx.signals.watch(GUIDANCE.iface, GUIDANCE.instance, {
            guidanceState: (v) => this._guard('guidance', () => this._onGuidance(v)),
        }, this.log)).then((s) => {
            this.navSub = s;
            this.log.info('signal Guidance ' + (s && s.error ? 'error: ' + s.error : 'subscribed'));
        }).catch((e) => this.log.info('route guidance not available: ' + (e && e.message || e)));
    }

    /** guidanceState: INACTIVE 0, CALCULATING_ROUTE 1, ACTIVE 2 (the car's catalog), by name or number; anything else reads as off. */
    _onGuidance(raw) {
        const v = raw && typeof raw === 'object' ? raw.guidanceState : raw;
        if (String(v) !== String(this.navRaw)) {
            this.navRaw = v;
            this.log.info('route guidance state ' + JSON.stringify(raw));
        }
        const on = enumNum(typeof v === 'string' ? v.toUpperCase() : v, GUIDANCE_STATE) === GUIDANCE_STATE.ACTIVE;
        if (on === this.navActive) return;
        this.navActive = on;
        this._modeChanged();
    }

    /**
     * functionalLibraryData: BMW's HUD shows its driver assistance block while it has the assist symbol (ldmSym
     * with a colour), the ACC car or distance bars, or a lit (not grey) lane-assist wheel.
     */
    _onAssist(v) {
        if (!v || typeof v !== 'object') return;
        const acc = v.activeCruiseControl || {}, sta = v.trafficJamAssist || {};
        const sym = enumNum(v.ldmSym, LDM_SYM), col = enumNum(v.ldmSymColor, LDM_COLOR);
        const car = enumNum(acc.symbolACC, ACC_SYM), bars = enumNum(acc.barsColorACC, ACC_BARS);
        const wheel = enumNum(sta.steeringWheel, STA_WHEEL);
        this.accSetRaw = isNum(v.cruiseCtrlSpeedHUD) ? v.cruiseCtrlSpeedHUD : null;
        const raw = [v.ldmSym, v.ldmSymColor, acc.symbolACC, acc.barsColorACC, sta.steeringWheel].join(' ');
        if (raw !== this.assistRaw) {
            this.assistRaw = raw;
            this.log.info('driver assistance on the HUD: symbol ' + v.ldmSym + ' ' + v.ldmSymColor + ', ACC ' + acc.symbolACC + ' ' + acc.barsColorACC + ', wheel ' + sta.steeringWheel);
        }
        const on = (!!sym && !!col) || !!car || !!bars || (!!wheel && wheel !== STA_WHEEL.LDM_STW_GREY);
        if (on === this.assistActive) return;
        this.assistActive = on;
        this._modeChanged();
    }

    /** The car-ahead messages as sent, when they change (an X3 repeats the same one every second), at most once a second,
     *  for calibrating config.acc against what BMW's HUD shows. */
    _logAhead(v) {
        const now = Date.now(), line = JSON.stringify(v);
        if (line === this.aheadLogged || now - this.aheadLogAt < 1000) return;
        this.aheadLogged = line; this.aheadLogAt = now;
        this.log.info('car ahead raw: ' + line + (isNum(this.accSetRaw) && this.accSetRaw !== 65535 ? ', set speed ' + this.accSetRaw : '') + ', speed ' + this._token('speed'));
    }

    /** raw * factor + offset from config.acc[key]. */
    _accScale(key, raw) {
        const c = (this.config.acc && this.config.acc[key]) || {};
        return raw * (isNum(c.factor) ? c.factor : 1) + (isNum(c.offset) ? c.offset : 0);
    }

    /** The gap in m: DataFrontVehicle's while it is fresh and available, else GapVehicleDrivingAhead's while a car is measured. */
    _gapM() {
        const now = Date.now(), a = this.ahead, b = this.ahead2;
        if (a && now - a.at < FRESH_MS && enumNum(a.q, AHEAD_Q) !== AHEAD_Q.EVENT_DATA_NOT_AVAILABLE && isNum(a.gapX)) return this._accScale('gap', a.gapX);
        if (b && now - b.at < FRESH_MS && b.measured && isNum(b.gap) && [6, 14, 15].indexOf(enumNum(b.q, AHEAD2_Q)) < 0) return this._accScale('gap', b.gap);
        return null;
    }

    /** The relative speed from the gap's rate of change (km/h, minus = closing), smoothed over REL_TAU_MS; reset without a gap. */
    _gapRate() {
        const now = Date.now(), g = this._gapM(), r = this.relFromGap;
        if (!isNum(g)) { this.relFromGap = null; return; }
        if (!r) { this.relFromGap = { v: null, gapM: g, at: now }; return; }
        const dt = now - r.at;
        if (dt < 200) return;
        const inst = (g - r.gapM) / (dt / 1000) * 3.6;
        const k = 1 - Math.exp(-dt / REL_TAU_MS);
        this.relFromGap = { v: isNum(r.v) ? r.v + (inst - r.v) * k : inst, gapM: g, at: now };
    }

    /** An ACC value: 'gap' m, 'rel' km/h (DataFrontVehicle's speed when sent, else the gap's rate), 'set'; null when missing or stale. */
    _acc(key) {
        const now = Date.now(), a = this.ahead;
        if (key === 'gap') return this._gapM();
        if (key === 'rel') {
            const own = this._raw('speed');
            if (!isNum(own) || own < 1) return null;        // standing still: "--" (the gap's rate is only noise then)
            if (a && now - a.at < FRESH_MS && enumNum(a.q, AHEAD_Q) !== AHEAD_Q.EVENT_DATA_NOT_AVAILABLE && isNum(a.speedX)) return this._accScale('rel', a.speedX);
            const r = this.relFromGap;
            return r && isNum(r.v) && now - r.at < FRESH_MS && isNum(this._gapM()) ? r.v : null;
        }
        if (key === 'set') return this.assistActive && isNum(this.accSetRaw) && this.accSetRaw !== 65535 ? this._accScale('set', this.accSetRaw) : null;
        return null;
    }

    /** The HUD mode now: normal, cruise, nav or cruiseNav (see the header). */
    _mode() {
        if (!this._modesOn() || this.setting('makeRoom') !== true) return 'normal';
        return this.navActive ? (this.assistActive ? 'cruiseNav' : 'nav') : (this.assistActive ? 'cruise' : 'normal');
    }

    _modeChanged() {
        const m = this._mode();
        if (m === this.activeMode) return;
        this.log.info('HUD mode ' + m);
        this._rebuild();
    }

    /** A widget as it is in a mode: its "in"[mode] fields over its own, or null when that is false. */
    _inMode(w, mode) {
        if (!w.in || !Object.prototype.hasOwnProperty.call(w.in, mode)) return w;
        const o = w.in[mode];
        return o === false ? null : Object.assign({}, w, o);
    }

    /** Boost from the engine unit when the sport display's value isn't there (config.dme, read-only UDS). */
    _startDme() {
        const dme = this.config.dme;
        if (!dme || !['boost', 'volt', 'pedal'].some((k) => Array.isArray(dme[k]) && dme[k].length)) return;
        let rd = null, busy = false, baro = 101.3, baroAt = 0, boostAskAt = 0;
        try {
            const { Diag } = require('./kit/diag');
            const { DidReader } = require('./kit/dids');
            const link = new Diag(this.ctx.signals, this.log);
            link.quiet = true;
            Promise.resolve().then(() => link.init()).catch((e) => this.log.info('engine unit link not available: ' + (e && e.message || e)));
            rd = new DidReader(link, { ecu: dme.ecu || 18 });
        } catch (e) { this.log.info('engine unit boost off: ' + (e && e.message || e)); return; }
        this.dmeTimer = setInterval(() => this._guard('engine unit boost', () => {
            const now = Date.now();
            if (busy || this.car.data().demo) return;
            // one question per tick, the pedal first (it moves the most), each only while a shown widget uses it
            const wantPedal = this.needsPedal && Array.isArray(dme.pedal) && now - this.pedalObdAt >= PEDAL_MS;
            const wantVolt = !wantPedal && this.needsVolt && Array.isArray(dme.volt) && now - this.volt12At > VOLT_MS;
            const wantBoost = !wantPedal && !wantVolt && this.needsBoost && Array.isArray(dme.boost) &&
                now - this.boostFesAt >= FRESH_MS && now - boostAskAt >= 400;
            if (!wantPedal && !wantVolt && !wantBoost) return;
            busy = true;
            (async () => {
                if (wantPedal) {
                    const v = await rd.value('pedal', dme.pedal);
                    this.pedalObdAt = Date.now();
                    this.pedalObd = isNum(v) ? v : null;
                    if (isNum(v) && Math.round(v) !== this.pedalObdLogged && now - this.pedalLogged > 200) {   // for config.pedal.obdRange
                        this.pedalObdLogged = Math.round(v); this.pedalLogged = now;
                        this.log.info('accelerator pedal (OBD) ' + v.toFixed(1) + ' %');
                    }
                    return;
                }
                if (wantVolt) {
                    const v = await rd.value('volt', dme.volt);
                    this.volt12At = Date.now();
                    this.volt12 = isNum(v) ? v : null;
                    return;
                }
                boostAskAt = now;
                if (now - baroAt > 60000 && Array.isArray(dme.baro)) {
                    baroAt = now;
                    const b = await rd.value('baro', dme.baro);
                    if (isNum(b)) baro = b;
                }
                const m = await rd.value('boost', dme.boost);
                if (isNum(m)) { this.boostDme = (m - baro) / 100; this.boostDmeAt = Date.now(); }
            })().catch((e) => this.log.info('engine unit boost: ' + (e && e.message || e))).then(() => { busy = false; });
        }), 100);
    }

    stop() {
        clearInterval(this.tickTimer);
        clearInterval(this.themeTimer);
        clearInterval(this.statusTimer);
        clearInterval(this.dmeTimer);
        clearTimeout(this.statusAskT);
        if (this.navSub) this.navSub.shutdown();
        this.clients.forEach((c) => c.close());
        this.atlases.clear();
    }

    /**
     * The glyph atlas of a font on a connection: an R8 asset of the font's characters in equal cells (cols x
     * rows), made on first use and kept while the connection lives (the client re-sends it by itself after a
     * reconnect). A widget's effect layer samples it; nothing is drawn by the asset itself.
     */
    _atlas(fontName, ci) {
        const key = ci + ':' + fontName;
        if (this.atlases.has(key)) return this.atlases.get(key);
        const font = textRaster.loadFont(fontName), glyphs = font.metrics.glyphs;
        const chars = Object.keys(glyphs).filter((ch) => ch.length === 1 && ch >= ' ' && ch <= '~').sort().slice(0, 64);
        if (!chars.length) throw new Error('font "' + fontName + '" has no printable glyphs for an atlas');
        const cellW = Math.max(1, Math.ceil(Math.max.apply(null, chars.map((ch) => glyphs[ch].advance)))) + 2;
        const cellH = font.metrics.cellHeight;
        const cols = Math.max(1, Math.min(16, Math.floor(2048 / cellW))), rows = Math.ceil(chars.length / cols);
        const w = cols * cellW, h = rows * cellH;
        const buf = Buffer.alloc(w * h, 0);
        chars.forEach((ch, i) => {
            const cell = textRaster.mask(cellW, cellH, ch, { font: fontName, align: 'center' });
            const cx = (i % cols) * cellW, cy = Math.floor(i / cols) * cellH;
            for (let y = 0; y < cellH; y++) cell.copy(buf, (cy + y) * w + cx, y * cellW, (y + 1) * cellW);
        });
        const c = this._clientAt(ci);
        const ref = c.asset({ target: this.target, format: 'r8', w, h, sampling: 'bilinear' });
        if (!ref) throw new Error('font "' + fontName + '": atlas asset refused (' + w + 'x' + h + ')');
        c.pixels(ref, null, buf);
        const a = { ref, c, ci, cols, rows, cellW, cellH, chars, bytes: w * h * 2 };
        this.atlases.set(key, a);
        this.log.info('glyph atlas "' + fontName + '"' + (ci ? ' on connection ' + (ci + 1) : '') + ': ' + chars.length + ' glyphs in ' +
            cellW + 'x' + cellH + ' cells, ' + w + 'x' + h + ' R8 asset, ' + mib(a.bytes) + ' of pixel memory');
        return a;
    }

    _atlasBytes() {
        let n = 0;
        this.atlases.forEach((a) => { n += a.bytes; });
        return n;
    }

    /** The glyph codes of a text in an atlas widget's cells, aligned; -1 is an empty cell. */
    _atlasCodes(x, s) {
        const a = x.atlas, n = x.cells, text = String(s).slice(0, n);
        const pad = n - text.length, w = x.w;
        const lead = w.align === 'right' ? pad : w.align === 'center' ? Math.floor(pad / 2) : 0;
        const codes = [];
        for (let i = 0; i < 32; i++) {
            const j = i - lead;
            const ch = j >= 0 && j < text.length ? text[j] : null;
            const k = ch === null ? -1 : a.chars.indexOf(ch);
            codes.push(i < n && ch !== null ? (k < 0 ? a.chars.indexOf(' ') : k) : -1);
        }
        return codes;
    }

    _guard(what, fn) {
        try { fn(); } catch (e) { this.log.error('hud ' + what + ': ' + (e && e.stack || e)); }
    }

    /* ---------------- status line (the center screen's first row) ---------------- */

    /** fn(text) whenever the status line changes. */
    onStatus(fn) { this.statusListeners.push(fn); if (this.lastStatus) fn(this.lastStatus); }

    /** The layout name to show now: per drive mode when that's on and known, else the plain setting. */
    _layoutName() {
        if (this.setting('byMode') === true && this.driveMode && MODE_KEY[this.driveMode]) {
            const v = this.setting(MODE_KEY[this.driveMode]);
            if (v) return v;
        }
        return this.setting('hudLayout');
    }

    _layoutLabel(name) {
        const lay = this.ctx.settings.item('hudLayout');
        const o = lay && (lay.options || []).find((x) => x[0] === name);
        return o ? o[1] : name;
    }

    /** The first widget on that layer, for the logs; a sheet is named by its first member plus how many more it holds. */
    _widgetOf(ci, ref) {
        let id = null, n = 0;
        this.widgets.forEach((x) => { if (x.ci === ci && x.ref === ref) { if (!id) id = x.w.id; n++; } });
        return n > 1 ? id + ' +' + (n - 1) : id;
    }

    /** Every layer of the layout now (effects, sheets and own image layers), each once: { c, ci, ref, key }. */
    _layerRefs() {
        const refs = [], seen = {};
        this.widgets.forEach((x) => {
            const key = x.ci + ':' + x.ref;
            if (!seen[key]) { seen[key] = true; refs.push({ c: x.c, ci: x.ci, ref: x.ref, key }); }
        });
        return refs;
    }

    /** How many connections the layout now uses. */
    _connCount() {
        const seen = {};
        this.widgets.forEach((x) => { seen[x.ci] = true; });
        return Object.keys(seen).length;
    }

    /** The connection a widget asks for ("conn", 0..3; 0 the app's own). */
    _connOf(w) {
        const n = isNum(w.conn) ? Math.floor(w.conn) : 0;
        return Math.max(0, Math.min(MAX_CONN - 1, n));
    }

    /** Layers per connection in a plan: [n on connection 1, n on 2, ...]. */
    _connCounts(plan) {
        const counts = [];
        plan.forEach((e) => { counts[e.conn] = (counts[e.conn] || 0) + 1; });
        for (let i = 0; i < counts.length; i++) counts[i] = counts[i] || 0;
        return counts;
    }

    _layerCount(n) { return n === 1 ? '1 layer' : n + ' layers'; }

    _statusSoon() {
        if (this._statusT) return;
        this._statusT = setTimeout(() => { this._statusT = null; this._guard('status', () => this._status()); }, 500);
    }

    /** ", 3 of 5 layers drawn (2 waiting: <reason>)" while some layers aren't shown; "" when all are. Counts layers, not widgets. */
    _drawnNote() {
        const ts = this.targetState;
        if (ts && (ts.state === 'waiting' || ts.state === 'parked') && ts.holder) {
            return ts.holder === 'foreign' ? ', waiting: another app has this display' : ', waiting: BMW is using this display';
        }
        const refused = this.refused ? ', refused ' + this.refused : '';
        const refs = this._layerRefs();
        if (!refs.length) return refused;
        let shown = 0, why = null, whyN = 0;
        refs.forEach((r) => {
            const st = this.layerStates.get(r.key);
            if (st && st.state === 'shown') shown++;
            else if (st) { whyN++; if (!why) why = st.state + (st.reason ? ': ' + st.reason : ''); }
        });
        if (shown === refs.length || (!why && !shown)) return refused;
        return ', ' + shown + ' of ' + this._layerCount(refs.length) + ' drawn' + (why ? ' (' + whyN + ' ' + why + ')' : '') + refused;
    }

    statusText() {
        if (!this.client.ready) {
            let there = false;
            try { there = fs.existsSync(this.socketPath); } catch (e) { /* treat as missing */ }
            return there ? this.label + ': connecting to cluster-render' : this.label + ' off: cluster-render is not installed or not running';
        }
        if (this.problem) return this.label + ': ' + this.problem;
        const byMode = this.setting('byMode') === true;
        const mode = byMode ? (this.driveMode ? ' (' + MODE_NAME[this.driveMode] + ')' : ' (drive mode not seen yet)') : '';
        const what = this.target === 'panel' ? 'cluster' : 'HUD';
        if (this.activeName === 'off' && this.modeOff) return this.label + ' off while ' + MODE_TEXT[this.activeMode] + ' shows' + mode;
        if (this.activeName === 'off') return this.label + ' off' + mode + ": BMW's own " + what + ' shows';
        const name = this._layoutLabel(this.activeName);
        const d = this.car.data();
        const demo = d.demo ? ', demo data' : '';
        const drawn = this._drawnNote();
        const conns = this._connCount();
        const layers = ', ' + this._layerCount(this._layerRefs().length) + (conns > 1 ? ' on ' + conns + ' connections' : '')
            + (this.pixelBytes ? ', ' + mib(this.pixelBytes) + ' of 16 MiB pixels' : '')
            + (this.activeMode !== 'normal' ? ', ' + this.activeMode + ' mode' : '');
        if (this.layoutTheme) return this.label + ' on' + mode + ': ' + name + ' theme' + layers + demo + drawn;
        const theme = THEMES[this.themeName] ? THEMES[this.themeName].name : this.themeName;
        const auto = this.setting('hudTheme') === 'auto' ? ' (Auto)' : '';
        return this.label + ' on' + mode + ': ' + name + ' layout, ' + theme + ' theme' + auto + layers + demo + drawn;
    }

    _status() {
        const s = this.statusText();
        if (s === this.lastStatus) return;
        this.lastStatus = s;
        this.statusListeners.forEach((fn) => { try { fn(s); } catch (e) { this.log.warn('status listener: ' + e); } });
    }

/* ---------------- theme, units, values ---------------- */

    _themeName() {
        if (this.layoutTheme) return this.layoutTheme;
        const t = this.setting('hudTheme');
        if (t !== 'auto') return t;
        return sun.isNight(Date.now(), this.location.lat, this.location.lon) ? 'night' : this.setting('dayTheme');
    }

    _barMax(w) { return Math.ceil(this.setting('redline') / 1000) * 1000 + ((w && w.over) || 0); }

    /** The shift point now ({ rpm, cold }) and whether the rpm is at or past it. */
    _shift() {
        const d = this.car.data();
        const sp = this.score.shiftPoint(d.oil);
        const rpm = isNum(this.rpmF) ? this.rpmF : d.rpm;
        sp.now = isNum(rpm) && rpm >= sp.rpm;
        sp.oilCold = isNum(d.oil) && d.oil < 80;
        return sp;
    }

    /** Boost in bar: the sport display's value while fresh, else the engine unit's, else null. */
    _boost() {
        const now = Date.now();
        if (isNum(this.boostFes) && now - this.boostFesAt < FRESH_MS) return this.boostFes;
        if (isNum(this.boostDme) && now - this.boostDmeAt < FRESH_MS) return this.boostDme;
        return null;
    }

    /** A tyre's pressure ('p', bar) or temperature ('t', C) at corner FL FR RL RR; steady made-up values on the demo drive. */
    /** A TPMS pressure raw (0.1 x the car's unit, 65532 and up = none) in bar: by the car's unit when known, else by the
     *  unit whose plausible tyre pressures the value falls in (bar 0.5-6, psi 7-60, kPa 60-600; psi also means F). */
    _tyreBar(raw) {
        if (!isNum(raw) || raw < 0 || raw >= 65532) return null;
        const v = raw / 10, k = PRESS_TO_BAR[this.carUnits.press];
        if (k) return v * k;
        if (v >= 0.5 && v <= 6) return v;
        if (v >= 7 && v < 60) { this.carUnits.psiSeen = true; return v / 14.5038; }
        if (v >= 60 && v <= 600) return v / 100;
        return v;
    }

    /** A TPMS temperature raw (the car's degrees + 40, 65535 = none) in C (the car sends F when set to F). */
    _tyreC(raw) {
        if (!isNum(raw) || raw < 0 || raw >= 65535) return null;
        const v = raw - 40, f = this.carUnits.temp ? this.carUnits.temp === 'F' : this.carUnits.psiSeen;
        return f ? (v - 32) * 5 / 9 : v;
    }

    /** The shifter programme letter next to the gear: S or M from the M drive display, else from the gearbox status, else D. */
    _program(d) {
        const p = this.program || d.program;
        return p === 'S' || p === 'M' ? p : 'D';
    }

    _tyre(kind, corner) {
        const v = this.tyres[kind][corner];
        if (isNum(v)) return v;
        if (!this.car.data().demo) return null;
        const rear = corner === 'RL' || corner === 'RR';
        return kind === 'p' ? (rear ? 2.5 : 2.3) : (rear ? 27 : 24);
    }

    _raw(name) {
        if (name === 'boost') return this._boost();
        if (name === 'rpm' && isNum(this.rpmF)) return this.rpmF;
        if (name === 'fuel' || name === 'range' || name === 'ambient') {
            // the kit's demo drive has none of these: made-up but steady values while it runs
            const demo = this.car.data().demo;
            if (name === 'fuel') return isNum(this.fuelL) ? Math.min(1, this.fuelL / (this.config.tankLitres || 65)) : demo ? 0.62 : null;
            if (name === 'range') return isNum(this.rangeKm) ? this.rangeKm : demo ? 368 : null;
            return isNum(this.ambient) ? this.ambient : demo ? 24 : null;
        }
        if (name === 'torquePct' || name === 'powerPct') {
            // the car's own sport display % while it sends one, else from the crank torque and app.json
            // config.engine's peaks (an M40i makes 500 Nm, 285 kW)
            if (Date.now() - (this.sportAt || 0) < FRESH_MS) {
                const v = name === 'powerPct' ? this.sportPower : this.sportTorque;
                if (isNum(v)) return v;
            }
            const e = this.config.engine || {}, d = this.car.data();
            if (!isNum(d.torque)) return null;
            if (name === 'torquePct') return Math.max(0, d.torque) / (e.torqueNm || 500) * 100;
            return isNum(d.rpm) ? Math.max(0, d.torque) * d.rpm / 9549 / (e.powerKw || 285) * 100 : null;
        }
        if (name.indexOf('setupLevel:') === 0) { const s = this._setup(); return s ? SETUP_LEVEL[s[name.slice(11)]] || 0 : 0; }
        if (name === 'throttle' || name === 'throttle10') { const t = this._throttle(); return isNum(t) ? (name === 'throttle' ? t : t / 10) : null; }
        if (name === 'brake10') return this._brakeLevel();
        if (name === 'volt12') return this._volt12();
        const d = this.car.data();
        return Object.prototype.hasOwnProperty.call(d, name) ? d[name] : null;
    }

    /** The accelerator pedal 0..100 % (raw * config.pedal.factor), null when not valid or older than 3 s; the demo drive's
     *  own (sim.js throttle 0..1). */
    _throttle() {
        const c0 = this.config.pedal || {};
        if (c0.source === 'obd') {
            // OBD PID 0x49 reads its own %, mapped from config.pedal.obdRange [at rest, flat out] to 0..100
            const r = Array.isArray(c0.obdRange) && c0.obdRange.length === 2 ? c0.obdRange : [0, 100];
            if (isNum(this.pedalObd) && Date.now() - this.pedalObdAt < 1000)
                return Math.max(0, Math.min(100, (this.pedalObd - r[0]) / (r[1] - r[0]) * 100));
            const d0 = this.car.data();
            return d0.demo ? (isNum(d0.throttle) ? Math.max(0, Math.min(100, d0.throttle * 100)) : 0) : null;
        }
        if (this.pedal && Date.now() - this.pedal.at < FRESH_MS) {
            const c = this.config.pedal || {};
            return Math.max(0, Math.min(100, this.pedal.raw * (isNum(c.factor) ? c.factor : 0.025) + (isNum(c.offset) ? c.offset : 0)));
        }
        const d = this.car.data();
        return d.demo ? (isNum(d.throttle) ? Math.max(0, Math.min(100, d.throttle * 100)) : 0) : null;
    }

    /** The brake lights on; the demo drive's while it slows down. */
    _brake() {
        if (this.brakeOn !== null) return this.brakeOn;
        const d = this.car.data();
        return !!d.demo && isNum(d.gLong) && d.gLong < -0.12;
    }

    /** The brake bar 0..10: 0 off; while braking the deceleration on a log scale (BRAKE_G0, BRAKE_GMAX), at least 1; 10
     *  without a deceleration reading. The deceleration is smoothed over BRAKE_TAU_MS so the bar does not flicker. */
    _brakeLevel() {
        const now = Date.now(), gl = this.car.data().gLong;
        const a = isNum(gl) ? Math.max(0, -gl) : null;
        if (isNum(a)) {
            const dt = this.decelAt ? Math.min(500, now - this.decelAt) : 0;
            this.decelF = isNum(this.decelF) ? this.decelF + (a - this.decelF) * (1 - Math.exp(-dt / BRAKE_TAU_MS)) : a;
            this.decelAt = now;
        } else this.decelF = null;
        if (!this._brake()) return 0;
        if (!isNum(this.decelF)) return 10;
        const v = 10 * Math.log(1 + Math.min(this.decelF, BRAKE_GMAX) / BRAKE_G0) / Math.log(1 + BRAKE_GMAX / BRAKE_G0);
        return Math.max(1, Math.min(10, v));
    }

    /** The 12 V battery's charge 0..100 % (raw * config.battery.factor), null when not sent; the demo drive's made up. */
    _batt12() {
        if (isNum(this.battRaw)) {
            const c = this.config.battery || {};
            return Math.max(0, Math.min(100, this.battRaw * (isNum(c.factor) ? c.factor : 1) + (isNum(c.offset) ? c.offset : 0)));
        }
        return this.car.data().demo ? 82 : null;
    }

    /** The 12 V system in V, null when the engine unit has not answered lately; the demo drive's made up. */
    _volt12() {
        if (isNum(this.volt12) && Date.now() - this.volt12At < VOLT_MS * 3) return this.volt12;
        const d = this.car.data();
        return d.demo ? (isNum(d.rpm) && d.rpm > 400 ? 14.1 : 12.6) : null;
    }

    /** Where the red and orange marks start on a rev scale that ends at `max` rpm, as fractions 0..1: red from the
     *  redline, but always covering at least the last 500 rpm (the M40i's scale ends right at its 7000 redline),
     *  orange over the 700 rpm before the red. */
    _redMarks(max) {
        const redFrom = Math.min(this.setting('redline'), max - 500) / max;
        return [redFrom, redFrom - 700 / max];
    }

    /** The scale label nearest the value now: 'speed' (SPEED_SCALE index) or 'rpm' (thousands); null without data. */
    _nearMark(kind) {
        if (kind === 'rpm') { const r = this._raw('rpm'); return isNum(r) ? Math.round(r / 1000) : null; }
        const v = this._raw('speed');
        if (!isNum(v)) return null;
        const us = this.setting('units') === 'us';
        return Math.round(scaleFrac(us ? v * 0.621371 : v, SPEED_SCALE[us ? 'us' : 'metric']) * 8);
    }

    /** The setup rows for the drive mode now, or null before the car has said. */
    _setup() {
        if (!this.driveMode) return null;
        if (this.driveVariant === 'individual') return SETUP.individual;
        return SETUP[this.driveMode === 'sport' && this.driveVariant === 'plus' ? 'sportplus' : this.driveMode];
    }

    /** {{token}} -> display text. */
    _token(tok) {
        const us = this.setting('units') === 'us';
        const fix = (v, n) => (isNum(v) ? v.toFixed(n) : '--');
        if (tok.indexOf('tyreP:') === 0) { const v = this._tyre('p', tok.slice(6)); return isNum(v) ? (us ? fix(v * 14.5038, 0) : fix(v, 1)) : '--'; }
        if (tok.indexOf('tyreT:') === 0) { const v = this._tyre('t', tok.slice(6)); return isNum(v) ? String(Math.round(us ? v * 9 / 5 + 32 : v)) : '--'; }
        switch (tok) {
            case 'u:pressure': return us ? 'psi' : 'bar';
            case 'throttle': { const v = this._throttle(); return isNum(v) ? String(Math.round(v)) : '--'; }
            case 'volt12': { const v = this._volt12(); return isNum(v) ? v.toFixed(1) : '--'; }
            case 'batt12': { const v = this._batt12(); return isNum(v) ? String(Math.round(v)) : '--'; }
            case 'accGap': { const v = this._acc('gap'); return isNum(v) ? String(Math.round(us ? v * 3.28084 : v)) : '--'; }
            case 'u:gap': return us ? 'FT' : 'M';
            case 'accRel': { const v = this._acc('rel'); return isNum(v) ? String(Math.round(us ? v * 0.621371 : v)) : '--'; }   // the HUD fonts have no '+'
            case 'u:rel': return us ? 'MPH' : 'KM/H';
            case 'accSet': { const v = this._acc('set'); return isNum(v) ? String(Math.round(v)) : '--'; }
            case 'speed': { const v = this._raw('speed'); return fix(isNum(v) ? (us ? v * 0.621371 : v) : v, 0); }
            case 'u:speed': return us ? 'MPH' : 'KM/H';
            case 'oil': case 'coolant': { const v = this._raw(tok); return fix(isNum(v) ? (us ? v * 9 / 5 + 32 : v) : v, 0); }
            case 'boost': { const v = this._raw('boost'); return us ? fix(isNum(v) ? v * 14.5038 : v, 1) : fix(v, 2); }
            case 'u:boost': return us ? 'PSI' : 'BAR';
            case 'u:temp': return us ? '°F' : '°C';
            case 'u:speedLc': return us ? 'mph' : 'km/h';
            case 'u:distLc': return us ? 'mi' : 'km';
            case 'range': { const v = this._raw('range'); return fix(isNum(v) ? (us ? v * 0.621371 : v) : v, 0); }
            case 'ambient': {
                const v = this._raw('ambient');
                if (!isNum(v)) return '--';
                const n = Math.round(us ? v * 9 / 5 + 32 : v);
                return (n > 0 ? '+' : '') + n;
            }
            case 'u:torque': return us ? 'lb-ft' : 'Nm';
            case 'torque': { const v = this._raw('torque'); return fix(isNum(v) ? (us ? v * 0.737562 : v) : v, 0); }
            case 'torquePct': case 'powerPct': { const v = this._raw(tok); return isNum(v) ? String(Math.min(100, Math.round(v))) : '--'; }
            case 'boostHi': return us ? '20' : '1.4';
            case 'boostMid': return us ? '10' : '0.7';
            case 'ampmLc': return this._token('ampm').toLowerCase();
            case 'gLat': case 'gLong': { const v = this._raw(tok); return isNum(v) ? Math.abs(v).toFixed(2) : '--'; }
            case 'rpm': case 'rpm10': return isNum(this.rpmShown) ? String(this.rpmShown) : (tok === 'rpm' ? '--' : '----');
            case 'shiftAt': return String(this._shift().rpm);
            case 'lastShift': return this.score.last ? String(this.score.last.rpm) : '--';
            case 'lastGears': { const l = this.score.last; return l && l.from !== '?' ? l.from + ' > ' + l.to : ''; }
            case 'verdict': return this.score.last ? this.score.last.verdict : '';
            case 'shiftPrompt': return this._shift().now ? 'SHIFT' : '';
            case 'coldNote': {
                const sp = this._shift();
                if (!sp.oilCold) return '';
                return sp.cold ? 'COLD · LIMIT ' + sp.rpm : 'OIL COLD · GO EASY';
            }
            case 'gearnum': {
                const d = this.car.data();
                if (d.stage === 'P' || d.stage === 'R' || d.stage === 'N') return d.stage;
                return isNum(d.gear) && d.gear > 0 ? String(d.gear) : (d.gear === 0 ? 'N' : '-');
            }
            case 'stage': {          // the selector letter alone: P R N, or D / S / M by the shifter programme
                const d = this.car.data();
                return d.stage === 'D' || (!d.stage && isNum(d.gear) && d.gear > 0) ? this._program(d) : (d.stage || '-');
            }
            case 'gearInD': {        // the gear number while driving, else nothing (the M "2D")
                const d = this.car.data();
                return (d.stage === 'D' || (!d.stage && isNum(d.gear))) && isNum(d.gear) && d.gear > 0 ? String(d.gear) : '';
            }
            case 'mode': {
                if (!this.driveMode) return '';
                const base = this.driveMode === 'sport' ? 'SPORT' : this.driveMode === 'eco' ? 'ECO PRO' : 'COMFORT';
                return base + (this.driveVariant === 'plus' ? ' PLUS' : this.driveVariant === 'individual' ? ' INDIVIDUAL' : '');
            }
            case 'gear': {
                const d = this.car.data();
                if (d.stage === 'P' || d.stage === 'R' || d.stage === 'N') return d.stage;
                const g = isNum(d.gear) && d.gear > 0 ? String(d.gear) : '';
                return d.stage === 'D' ? this._program(d) + g : g;
            }
            case 'time': case 'ampm': {
                const now = this._now();
                const h = now.getHours(), m = now.getMinutes();
                if (tok === 'ampm') return this.setting('clock') === '12h' ? (h < 12 ? 'AM' : 'PM') : '';
                if (this.setting('clock') === '24h') return pad2(h) + ':' + pad2(m);
                return ((h % 12) || 12) + ':' + pad2(m);
            }
            default:
                if (tok.indexOf('spd:') === 0) { const v = SPEED_SCALE[us ? 'us' : 'metric'][Number(tok.slice(4))]; return v === undefined ? '' : String(v); }   // speed scale labels
                if (tok.indexOf('temp:') === 0) { const c = Number(tok.slice(5)); return isNum(c) ? String(us ? Math.round((c * 9 / 5 + 32) / 10) * 10 : Math.round(c)) : '--'; }   // gauge labels: °F to the 10
                if (tok.indexOf('setup:') === 0) { const s = this._setup(); return s ? s[tok.slice(6)] || '' : '--'; }
                if (tok.indexOf('signal:') === 0) { const v = this._raw(tok.slice(7)); return isNum(v) ? (Math.round(v * 10) / 10).toString() : '--'; }
                return '{{' + tok + '}}';
        }
    }

    /** KombiIF statusShowTimeDate: the cluster's displayed local time against UTC now, to the nearest 15 min within
     *  -12..+14 h, is the car's time zone. 255 = not sent. */
    _onCarClock(v) {
        const h = v && v.displayHour, m = v && v.displayMinute;
        if (!isNum(h) || !isNum(m) || h > 23 || m > 59) return;
        const now = new Date();
        let off = h * 60 + m - (now.getUTCHours() * 60 + now.getUTCMinutes());
        off = Math.round(off / 15) * 15;
        while (off < -12 * 60) off += 1440;
        while (off > 14 * 60) off -= 1440;
        if (off === this.carOffsetMin) return;
        this.carOffsetMin = off;
        this.log.info('car clock ' + h + ':' + pad2(m) + ': time zone UTC' + (off < 0 ? '-' : '+') + pad2(Math.floor(Math.abs(off) / 60)) + ':' + pad2(Math.abs(off) % 60));
    }

    /** Local time: config.utcOffsetMinutes when set, else the car's time zone once the cluster's clock has been seen, else
     *  the unit's own (UTC on the car). */
    _now() {
        const cfg = this.config.utcOffsetMinutes;
        const off = isNum(cfg) ? cfg : this.carOffsetMin;
        if (!isNum(off)) return new Date();
        const d = new Date(Date.now() + off * 60000);
        return { getHours: () => d.getUTCHours(), getMinutes: () => d.getUTCMinutes() };
    }

    _resolve(template) { return String(template).replace(/\{\{([a-zA-Z0-9:]+)\}\}/g, (_, t) => this._token(t)); }

    /* ---------------- layers ---------------- */

    _rebuild() {
        this._guard('rebuild', () => this._rebuildInner());
        this._status();
    }

    _rebuildInner() {
        if (!this.client.ready) return; // the 'ready' handler calls us again
        this._layerRefs().forEach((r) => r.c.drop(r.ref));
        this.widgets.clear();
        this.sheets = [];
        this.pixelBytes = 0;
        this.layerStates.clear();
        this.refused = null;
        clearTimeout(this.statusAskT); this.statusAskT = null;
        this.car.setRedline(this.setting('redline'));
        const name = this._layoutName(), mode = this._mode();
        this.activeName = name;
        this.activeMode = mode;
        this.modeOff = false;
        if (name === 'off') {
            this.problem = null; this.layoutTheme = null; this.needsBoost = false; this.needsVolt = false; this.needsPedal = false;
            this.log.info('off: nothing drawn, BMW\'s own ' + (this.target === 'panel' ? 'cluster' : 'HUD') + ' shows');
            return;
        }
        let layout;
        try { layout = this.layouts.load(name); } catch (e) {
            this.problem = e.message;
            this.log.warn('layout "' + name + '" unusable (' + e.message + '); showing nothing');
            return;
        }
        if (mode !== 'normal' && (layout.modes || []).indexOf(mode) < 0) {
            this.problem = null; this.layoutTheme = null; this.needsBoost = false; this.needsVolt = false; this.needsPedal = false;
            this.activeName = 'off'; this.modeOff = true;
            this.log.info('layout "' + layout.name + '" has no ' + mode + ' variant: nothing drawn, ' + MODE_TEXT[mode] + ' shows');
            return;
        }
        this.problem = null;
        this.layoutTheme = layout.theme && THEMES[layout.theme] ? layout.theme : null;
        this.themeName = this._themeName();
        this.theme = THEMES[this.themeName] || THEMES.classic;
        this.log.info('layout "' + layout.name + '", theme ' + this.theme.name + (this.layoutTheme ? '' : ' (' + this.setting('hudTheme') + ')') + (mode !== 'normal' ? ', ' + mode + ' mode' : ''));
        const shown = layout.widgets.map((w) => this._inMode(w, mode)).filter((w) => w && !(w.toggle && !this._toggleOn(w.toggle)) && !(w.themes && w.themes.indexOf(this.themeName) < 0));
        this.needsBoost = /boost/.test(JSON.stringify(shown));
        this.needsVolt = /volt12/.test(JSON.stringify(shown));
        this.needsPedal = /throttle/.test(JSON.stringify(shown));
        // plan the layers first (a sheet's size is only known once every member is placed), then make them
        // in that order: within a class and z, cluster-render puts the newer layer on top. Small sheets
        // first; a bigger limit only when the layer budget needs it (see the header).
        const area = this.size[0] * this.size[1];
        const over = (p) => this._connCounts(p).some((k) => k > LAYER_BUDGET);
        let maxPx = Math.floor(area / SHEET_AREA_FRAC), plan = this._plan(shown, maxPx);
        while (over(plan) && maxPx !== Infinity) {
            maxPx = maxPx * 2 >= area ? Infinity : maxPx * 2;
            plan = this._plan(shown, maxPx);
        }
        let effects = 0, own = 0, sheets = 0, bytes = 0, px = 0;
        plan.forEach((e) => {
            if (e.kind === 'sheet') { sheets++; bytes += e.w * e.h * 4; px += e.w * e.h * 8; this._guard('sheet ' + e.members[0].id, () => this._createSheet(e)); }
            else {
                if (IMAGE_TYPES[e.w.type]) { own++; px += e.w.w * e.w.h * 8; } else effects++;
                this._guard('widget ' + e.w.id, () => this._create(e.w, null));
            }
        });
        const atlasBytes = this._atlasBytes();
        px += atlasBytes;
        this.pixelBytes = px;
        const n = this._layerRefs().length, counts = this._connCounts(plan);
        this.log.info('layout "' + layout.name + '": ' + shown.length + ' widgets, ' + this._layerCount(n) + ' (' + effects + ' effects, ' +
            sheets + ' image sheets' + (own ? ', ' + own + ' own image layers' : '') + ')' +
            (counts.length > 1 ? ' on ' + counts.length + ' connections (' + counts.join(' + ') + ')' : '') + ', sheet limit ' +
            (maxPx === Infinity ? 'unlimited' : maxPx + ' px') + ', whole-sheet writes ' + bytes + ' bytes, pixel memory ' + mib(px) + ' of 16 MiB' +
            (atlasBytes ? ' (' + this.atlases.size + ' glyph atlas' + (this.atlases.size > 1 ? 'es' : '') + ' ' + mib(atlasBytes) + ')' : ''));
        counts.forEach((k, ci) => {
            if (k > LAYER_BUDGET) this.log.warn('layout "' + layout.name + '" needs ' + k + ' layers on connection ' + (ci + 1) + ', cluster-render draws at most ' + LAYER_BUDGET + ' per connection');
        });
        if (px > PIXEL_BYTES) this.log.warn('layout "' + layout.name + '" needs ' + mib(px) + ' of pixel memory; cluster-render has 16 MiB for every app together (each image counts twice)');
        this.statusAskT = setTimeout(() => { this.statusAskT = null; this._guard('status request', () => this.client.status()); }, STATUS_ASK_MS);
    }

    /**
     * The layers of a layout, in the order to make them: { kind: 'layer', w } for an effect or an "own"
     * image widget, { kind: 'sheet', klass, z, x, y, w, h, members } for a packed image layer. Widgets are
     * taken in file order; an image widget joins the first sheet of its (class, z) group that was opened
     * after every earlier entry of that group its rect intersects (so what overlaps it stays under it, as
     * file order says) and whose union box with it stays within maxPx pixels, else a new sheet is opened
     * at the end.
     */
    _plan(widgets, maxPx) {
        const plan = [];
        const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const union = (s, w) => {
            const x = Math.min(s.x, w.x), y = Math.min(s.y, w.y);
            return { x, y, w: Math.max(s.x + s.w, w.x + w.w) - x, h: Math.max(s.y + s.h, w.y + w.h) - y };
        };
        widgets.forEach((w) => {
            const klass = w.class || 'content', z = w.z || 0, conn = this._connOf(w);
            if (!IMAGE_TYPES[w.type] || w.own === true) { plan.push({ kind: 'layer', w, klass, z, conn }); return; }
            let after = -1;
            plan.forEach((e, i) => {
                if (e.klass !== klass || e.z !== z || e.conn !== conn) return;
                if (e.kind === 'layer' ? hit(e.w, w) : e.members.some((m) => hit(m, w))) after = i;
            });
            let sheet = null, box = null;
            for (let i = after + 1; i < plan.length && !sheet; i++) {
                const s = plan[i];
                if (s.kind !== 'sheet' || s.klass !== klass || s.z !== z || s.conn !== conn) continue;
                const u = union(s, w);
                if (u.w * u.h <= maxPx) { sheet = s; box = u; }
            }
            if (!sheet) { sheet = { kind: 'sheet', klass, z, conn, x: w.x, y: w.y, w: w.w, h: w.h, members: [], ref: 0, c: null, ci: conn, buf: null }; plan.push(sheet); }
            else { sheet.x = box.x; sheet.y = box.y; sheet.w = box.w; sheet.h = box.h; }
            sheet.members.push(w);
        });
        return plan;
    }

    /** One image layer for a sheet: every member painted into a local buffer, then sent whole once. */
    _createSheet(s) {
        const c = this._clientAt(s.conn);
        const ref = c.image({ target: this.target, klass: s.klass, z: s.z, x: s.x, y: s.y, w: s.w, h: s.h, iw: s.w, ih: s.h });
        if (!ref) { this.log.warn('sheet ' + s.klass + '/' + s.z + ' at ' + s.x + ',' + s.y + ' ' + s.w + 'x' + s.h + ': layer refused'); return; }
        s.ref = ref; s.c = c; s.ci = s.conn;
        s.buf = Buffer.alloc(s.w * s.h * 4, 0);
        this.sheets.push(s);
        s.members.forEach((w) => this._guard('widget ' + w.id, () => this._create(w, s)));
        const buf = s.buf;
        s.buf = null;                    // from here on _blit sends dirty rects
        c.pixels(ref, null, buf);
    }

    /**
     * Every pixel painter goes through here: the widget's pixels (rects in the widget's own px, or null for
     * the whole widget) to its own layer, or into its sheet: the local buffer while the sheet is being
     * filled on create, else dirty rects translated by the sheet's offset.
     */
    _blit(x, rects, buf) {
        const w = x.w, s = x.sheet;
        if (!s) { x.c.pixels(x.ref, rects, buf); return; }
        const rs = rects && rects.length ? rects : [{ x: 0, y: 0, w: w.w, h: w.h }];
        const dx = w.x - s.x, dy = w.y - s.y;
        const moved = rs.map((r) => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }));
        if (!s.buf) { s.c.pixels(s.ref, moved, buf); return; }
        let off = 0;
        moved.forEach((r) => {
            for (let y = 0; y < r.h; y++) {
                buf.copy(s.buf, ((r.y + y) * s.w + r.x) * 4, off, off + r.w * 4);
                off += r.w * 4;
            }
        });
    }

    /**
     * A whole repaint of an image widget: the first time (or while its sheet is being filled) the whole widget
     * goes up; after that only the one rectangle around the pixels that changed, or nothing at all.
     */
    _blitDiff(x, buf) {
        const w = x.w, was = x.px;
        x.px = buf;
        if (!was || (x.sheet && x.sheet.buf)) { this._blit(x, null, buf); return; }
        const c = changes(was, buf, w.w, w.h);
        if (c) this._blit(x, [c.rect], c.px);
    }

    /** "key" is on while that bool setting is on; "!key" while it is off. */
    _toggleOn(t) {
        const not = t.charAt(0) === '!';
        const k = not ? t.slice(1) : t, eq = k.indexOf('=');
        const on = eq > 0 ? String(this.setting(k.slice(0, eq))) === k.slice(eq + 1) : this.setting(k) !== false;
        return not ? !on : on;
    }

    /** A widget: on its own layer (sheet null: an effect, or an image widget with "own": true), or a member of a sheet. */
    _create(w, sheet) {
        let ref, c;
        if (sheet) { ref = sheet.ref; c = sheet.c; }
        else {
            c = this._clientAt(this._connOf(w));
            const base = { target: this.target, klass: w.class || 'content', z: w.z || 0, x: w.x, y: w.y, w: w.w, h: w.h };
            if (IMAGE_TYPES[w.type]) ref = c.image(Object.assign({ iw: w.w, ih: w.h }, base));
            else ref = c.effect(Object.assign({ fs: w.type === 'swatch' ? calibration.SWATCH : shaders[w.type] }, base));
            if (!ref) { this.log.warn('widget "' + w.id + '": layer refused'); return; }
        }
        const x = { w, ref, c, ci: sheet ? sheet.ci : this._connOf(w), sheet: sheet || null, last: null, lastPaint: 0, px: null };
        this.widgets.set(w.id, x);
        const t = this.theme;
        if (w.type === 'atext') {
            const a = this._atlas(w.font, x.ci);
            x.atlas = a;
            x.cells = Math.max(1, Math.min(32, isNum(w.cells) ? Math.floor(w.cells) : Math.floor(w.w / a.cellW)));
            c.bind(ref, 'u_font', a.ref);
            c.uniform(ref, 'u_cells', [x.cells]);
            c.uniform(ref, 'u_grid', [a.cols, a.rows]);
            c.uniform(ref, 'u_color', rgba(color(t, w.color || 'fg')));
            c.uniform(ref, 'u_text', this._atlasCodes(x, ''), { type: 'vec4' });
            if (w.w !== x.cells * a.cellW || w.h !== a.cellH) {
                this.log.info('widget "' + w.id + '": ' + x.cells + ' cells of ' + (w.w / x.cells).toFixed(1) + 'x' + w.h +
                    ' px; the glyphs keep their shape at w ' + x.cells * a.cellW + ', h ' + a.cellH);
            }
        } else if (w.type === 'gridlabels') this._paintGridLabels(x);
        else if (w.type === 'icon') this._blit(x, null, paintIcon(w.icon, w.w, w.h, color(t, w.color || 'fg')));
        else if (w.type === 'sdash') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_geo', w.geo);
            c.uniform(ref, 'u_k', w.k);
            c.uniform(ref, 'u_w', [w.band]);
            c.uniform(ref, 'u_inner', [w.inner || w.band + 18]);
            c.uniform(ref, 'u_scale', w.scale || [w.geo[2], w.geo[0]]);
            c.uniform(ref, 'u_ticks', w.ticks);
            const [redFrom, orange] = this._redMarks(w.rpmMax || 8000);
            c.uniform(ref, 'u_redFrom', [redFrom]);
            c.uniform(ref, 'u_orange', [orange]);
            c.uniform(ref, 'u_fuelSeg', w.fuelSeg);
            c.uniform(ref, 'u_oilSeg', w.oilSeg);
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeR', [this._holeRadius(w)]);
            c.uniform(ref, 'u_holeCut', Array.isArray(w.holeCut) && w.holeCut.length === 4 ? w.holeCut : [0, 0, 0, 0]);
            c.uniform(ref, 'u_strip', w.strip);
            c.uniform(ref, 'u_topEnd', [w.topEnd]);
        } else if (w.type === 'mdash') {
            const ty = w.tyres || [0, 0, 0], L = w.gaugeL || {}, R = w.gaugeR || {}, b = w.blade || {};
            const bars = Array.isArray(w.segbars) ? w.segbars.slice(0, 4) : [];
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_card', w.card || [0, 0, 0, 0]);
            c.uniform(ref, 'u_cardTop', w.cardTop || [0, 0, -99999]);
            c.uniform(ref, 'u_cardCutR', w.cardCutR || [0, 0, 0]);
            c.uniform(ref, 'u_cardFill', [isNum(w.cardFill) ? w.cardFill : 0]);
            c.uniform(ref, 'u_blade', [isNum(b.xm) ? b.xm - w.x : 99999, (b.ym || 0) - w.y, b.kTop || 0, b.kBot || 0]);
            c.uniform(ref, 'u_bladeB', [b.round || 40, isNum(w.bladeGap) ? w.bladeGap : 14]);
            c.uniform(ref, 'u_line', w.line || [0, -99, 0, 1]);
            c.uniform(ref, 'u_tyre', [ty[0] - w.x, ty[1] - w.y, ty[2] || 0]);
            c.uniform(ref, 'u_mark', w.mark || [0, 0, 0]);
            c.uniform(ref, 'u_red', rgb(t.hot));
            [0, 1, 2, 3].forEach((i) => {
                const s = bars[i];
                c.uniform(ref, 'u_seg' + i, s ? [s.x - w.x, s.y - w.y, s.w, s.h] : [0, 0, 0, 0]);
            });
            c.uniform(ref, 'u_segMax', [0, 1, 2, 3].map((i) => (bars[i] && bars[i].max) || 1));
            c.uniform(ref, 'u_segSlant', [isNum(w.segSlant) ? w.segSlant : 9]);
            x.gauges = [['u_gaugeL', L], ['u_gaugeR', R]];
            x.bars = bars;
        } else if (w.type === 'mtach') {
            const max = w.max || 8000, [redFrom, orange] = this._redMarks(max);
            const right = w.side === 'right';
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_side', [right ? 1 : -1]);
            c.uniform(ref, 'u_geoA', [w.y0 - w.y, w.y8 - w.y, w.ym - w.y, right ? w.x + w.w - w.xm : w.xm - w.x]);
            c.uniform(ref, 'u_geoB', [w.kTop, w.kBot, w.round || 40]);
            c.uniform(ref, 'u_wid', [w.wBot, w.wTop, w.wBend || 0]);
            c.uniform(ref, 'u_ticks', [max / 1000]);
            c.uniform(ref, 'u_orange', [orange]);
            c.uniform(ref, 'u_redFrom', [redFrom]);
            c.uniform(ref, 'u_red', rgb(t.hot));
        }
        else if (w.type === 'grid') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_step', [w.step || 50]);
            c.uniform(ref, 'u_major', [w.major || 2]);
            c.uniform(ref, 'u_minor', rgba([255, 255, 255, 90]));
            c.uniform(ref, 'u_majorC', rgba([0, 255, 140, 255]));
        } else if (w.type === 'stripe') this._paintStripe(x);
        else if (w.type === 'scale') this._paintScale(x);
        else if (w.type === 'shiftbar') {
            const max = this._barMax(), red = this.setting('redline');
            const midAt = t.bar.midAt === 'shift' ? (red - 1500) / max : t.bar.midAt;
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_segs', [w.segments || 40]);
            c.uniform(ref, 'u_low', rgb(t.bar.low));
            c.uniform(ref, 'u_mid', rgb(t.bar.mid));
            c.uniform(ref, 'u_high', rgb(t.bar.high));
            c.uniform(ref, 'u_midAt', [midAt]);
            c.uniform(ref, 'u_highAt', [(red - 500) / max]);
            c.uniform(ref, 'u_track', rgba(t.track));
            c.uniform(ref, 'u_flash', [0]);
        } else if (w.type === 'arc') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_color', rgb(color(t, w.color || 'arc')));
            c.uniform(ref, 'u_track', rgba(t.track));
            c.uniform(ref, 'u_width', [w.width || 7]);
            c.uniform(ref, 'u_start', [(w.start === undefined ? 225 : w.start) * Math.PI / 180]);
            c.uniform(ref, 'u_sweep', [(w.sweep === undefined ? 270 : w.sweep) * Math.PI / 180]);
        } else if (w.type === 'segbar') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_segs', [w.max]);
            c.uniform(ref, 'u_on', rgba(color(t, w.color || 'hot')));
            c.uniform(ref, 'u_offC', rgba(color(t, 'track')));
            c.uniform(ref, 'u_slant', [w.slant || 0]);
            c.uniform(ref, 'u_gap', [isNum(w.gap) ? w.gap : 8]);
        } else if (w.type === 'revbar') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_top', [w.top || 8]);
            c.uniform(ref, 'u_barH', [w.barH]);
            c.uniform(ref, 'u_slant', [w.slant || 12]);
            c.uniform(ref, 'u_max', [this._barMax(w)]);
            c.uniform(ref, 'u_red', [this.setting('redline')]);
            c.uniform(ref, 'u_from', rgb(t.rev.from));
            c.uniform(ref, 'u_to', rgb(t.rev.to));
            c.uniform(ref, 'u_hot', rgb(t.hot));
            c.uniform(ref, 'u_track', rgba(t.track));
            c.uniform(ref, 'u_tick', rgba(t.dim));
            c.uniform(ref, 'u_fg', rgba(t.fg));
        } else if (w.type === 'lights') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_n', [w.count || 12]);
            c.uniform(ref, 'u_tail', [w.tail || 0]);
            c.uniform(ref, 'u_round', [w.round ? 1 : 0]);
            c.uniform(ref, 'u_green', rgb(LIGHTS.green));
            c.uniform(ref, 'u_yellow', rgb(LIGHTS.yellow));
            c.uniform(ref, 'u_red', rgb(LIGHTS.red));
            c.uniform(ref, 'u_blue', rgb(LIGHTS.blue));
            c.uniform(ref, 'u_off', [w.off === undefined ? 0.14 : w.off]);
        } else if (w.type === 'fill') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_color', rgba(color(t, w.color || 'bg')));
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeR', [this._holeRadius(w)]);
        } else if (w.type === 'box') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_fill', rgba(color(t, w.fill || 'panel')));
            c.uniform(ref, 'u_line', rgba(color(t, w.line || 'line')));
            c.uniform(ref, 'u_head', rgba(color(t, w.headColor || 'head')));
            c.uniform(ref, 'u_headH', [w.head || 0]);
            c.uniform(ref, 'u_border', [w.border === undefined ? 2 : w.border]);
            c.uniform(ref, 'u_radius', [w.radius || 0]);
        } else if (w.type === 'swatch') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_n', [w.steps || 11]);
        } else if (w.type === 'swatchimg') this._blit(x, null, calibration.swatchImage(w.w, w.h, w.steps || 11));
        else if (w.type === 'boxes') {
            // the box list goes up as two vec4 arrays (x, y, w, h and headH, border, radius, headKind), 12 slots
            const list = (Array.isArray(w.boxes) ? w.boxes : []).filter((b) => b && isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h)
                && !(b.toggle && !this._toggleOn(b.toggle))).slice(0, 12);
            const rects = [], styles = [];
            for (let i = 0; i < 12; i++) {
                const b = list[i];
                rects.push(b ? b.x - w.x : 0, b ? b.y - w.y : 0, b ? b.w : 0, b ? b.h : 0);
                styles.push(b ? b.head || 0 : 0, b ? (b.border === undefined ? 2 : b.border) : 0, b ? b.radius || 0 : 0, b && b.headColor === 'accent' ? 1 : 0);
            }
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_bg', rgba(color(t, w.color || 'bg')));
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeR', [this._holeRadius(w)]);
            c.uniform(ref, 'u_n', [list.length]);
            c.uniform(ref, 'u_box', rects, { type: 'vec4' });
            c.uniform(ref, 'u_boxStyle', styles, { type: 'vec4' });
            c.uniform(ref, 'u_fill', rgba(color(t, w.fill || 'panel')));
            c.uniform(ref, 'u_line', rgba(color(t, w.line || 'line')));
            c.uniform(ref, 'u_head', rgba(color(t, w.head || 'head')));
            c.uniform(ref, 'u_accent', rgba(color(t, w.accent || 'accent')));
        }
        this._update(x, Date.now(), true);
    }

    /** A widget's map hole in layer px, inset by "holeInset" (6) a side, while "holeWhen" is on; else no hole. */
    _hole(w) {
        const h = w.hole && w.holeWhen && this.setting(w.holeWhen) === true ? w.hole : null;
        if (!h) return [0, 0, 0, 0];
        const inset = isNum(w.holeInset) ? w.holeInset : 6;
        return [h[0] + inset - w.x, h[1] + inset - w.y, Math.max(0, h[2] - 2 * inset), Math.max(0, h[3] - 2 * inset)];
    }

    _holeRadius(w) { return isNum(w.holeRadius) ? w.holeRadius : 28; }

    _tick() {
        const now = Date.now();
        this._smoothRpm(now);
        if (!this.client.ready) return;
        // shift light: blink the whole bar at 8 Hz once the rpm reaches the redline
        const rpm = this._raw('rpm');
        const flashing = isNum(rpm) && rpm >= this.setting('redline') - 150;
        this.flash = flashing ? Math.floor(now / 62.5) % 2 === 0 : false;
        this.widgets.forEach((x) => this._guard('widget ' + x.w.id, () => this._update(x, now, false)));
    }

    /** BMW-like tach: a 120 ms filter, and a readout that moves in 50 rpm steps, only by 40 rpm or more. */
    _smoothRpm(now) {
        const raw = this.car.data().rpm;
        const dt = this.lastTickT ? Math.min(500, now - this.lastTickT) : 0;
        this.lastTickT = now;
        if (!isNum(raw)) { this.rpmF = null; this.rpmShown = null; return; }
        this.rpmF = isNum(this.rpmF) ? this.rpmF + (raw - this.rpmF) * (1 - Math.exp(-dt / 120)) : raw;
        if (!isNum(this.rpmShown) || Math.abs(this.rpmF - this.rpmShown) >= 40) this.rpmShown = Math.max(0, Math.round(this.rpmF / 50) * 50);
    }

    _update(x, now, force) {
        const w = x.w;
        if (w.type === 'atext') {
            if (!force && now - x.lastPaint < (w.rate || TEXT_MS)) return;
            const s = this._resolve(w.text);
            if (!force && s === x.last) return;
            x.last = s; x.lastPaint = now;
            x.c.uniform(x.ref, 'u_text', this._atlasCodes(x, s), { type: 'vec4' });
        } else if (w.type === 'text') {
            if (!force && now - x.lastPaint < (w.rate || TEXT_MS)) return;
            const s = w.needs && this._token(w.needs) === '--' ? '' : this._resolve(w.text);
            let role = w.color || 'fg';
            if (w.colorBy === 'verdict' && this.score.last) role = VERDICT[this.score.last.verdict] || role;
            if (w.near && this._nearMark(w.near[0]) === w.near[1]) role = w.nearColor || 'fg';
            if (w.hotWhen || w.coldWhen) {
                const sp = this._shift();
                if (w.coldWhen && sp[w.coldWhen]) role = VERDICT.COLD;
                if (w.hotWhen && sp[w.hotWhen]) role = 'hot';
            }
            const key = s + '|' + role;
            if (!force && key === x.last) return;
            x.last = key; x.lastPaint = now;
            const buf = textRaster.drawText(w.w, w.h, s, {
                font: w.font, color: color(this.theme, role), align: w.align, spacing: w.spacing,
                color2: w.color2 && role !== 'hot' ? color(this.theme, w.color2) : null,
                glow: w.glow ? this.theme.glow : 0,
            });
            this._blitDiff(x, buf);
        } else if (w.type === 'badge') {
            if (!force && now - x.lastPaint < TEXT_MS) return;
            const s = this._resolve(w.text);
            let tone = VERDICT.COLD, fresh = false;
            if (w.tone === 'verdict' && this.score.last) {
                tone = VERDICT[this.score.last.verdict] || this.theme.fg;
                fresh = now - this.score.last.at < 2500;
            }
            const key = s + '|' + tone + '|' + fresh;
            if (!force && key === x.last) return;
            x.last = key; x.lastPaint = now;
            this._blitDiff(x, this._paintBadge(w, s, tone, fresh));
        } else if (w.type === 'shiftbar') {
            const rpm = this._raw('rpm');
            const segs = w.segments || 40;
            const v = isNum(rpm) ? Math.min(1, Math.max(0, rpm / this._barMax())) : 0;
            const q = Math.round(v * segs * 2) / (segs * 2);        // only resend on half-segment steps
            const key = q + (this.flash ? 'f' : '');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_value', [q]);
            x.c.uniform(x.ref, 'u_flash', [this.flash ? 1 : 0]);
        } else if (w.type === 'arc') {
            const raw = this._raw(w.signal);
            const v = isNum(raw) ? Math.min(1, Math.max(0, (raw - w.min) / (w.max - w.min))) : 0;
            const q = Math.round(v * 200) / 200;
            if (!force && q === x.last) return;
            x.last = q;
            x.c.uniform(x.ref, 'u_value', [q]);
        } else if (w.type === 'sdash') {
            const us = this.setting('units') === 'us';
            const sp = this._raw('speed'), rpm = this._raw('rpm'), fuel = this._raw('fuel'), oil = this._raw('oil');
            const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 500) / 500;
            const vals = [
                q(isNum(sp) ? scaleFrac(us ? sp * 0.621371 : sp, SPEED_SCALE[us ? 'us' : 'metric']) : 0),
                q(isNum(rpm) ? rpm / (w.rpmMax || 8000) : 0),
                q(isNum(fuel) ? fuel : 0),
                q(isNum(oil) ? (oil - 50) / 100 : 0),
            ];
            const key = vals.join('|');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_speed', [vals[0]]);
            x.c.uniform(x.ref, 'u_rpm', [vals[1]]);
            x.c.uniform(x.ref, 'u_fuel', [vals[2]]);
            x.c.uniform(x.ref, 'u_oil', [vals[3]]);
        } else if (w.type === 'mdash') {
            const vals = x.gauges.map(([u, G]) => {
                const v = G.signal ? this._raw(G.signal) : null;
                return [u, G, isNum(v) ? Math.round(Math.min(1, Math.max(0, (v - G.min) / (G.max - G.min))) * 200) / 200 : 0];
            });
            // the setup level bars: the segment at round(signal) is lit (1-based; 0 = none)
            const lit = [0, 1, 2, 3].map((i) => {
                const s = x.bars[i], v = s && s.signal ? this._raw(s.signal) : null;
                return s && isNum(v) ? Math.max(0, Math.min(s.max || 1, Math.round(v))) : 0;
            });
            const key = vals.map((v) => v[2]).join('|') + '|' + lit.join('|');
            if (!force && key === x.last) return;
            x.last = key;
            vals.forEach(([u, G, v]) => x.c.uniform(x.ref, u, [G.cx || 0, G.cy || 0, G.r || 0, v]));
            x.c.uniform(x.ref, 'u_segLit', lit);
        } else if (w.type === 'mtach') {
            const rpm = this._raw('rpm'), sp = this._shift();
            const v = isNum(rpm) ? Math.min(1, Math.max(0, rpm / (w.max || 8000))) : 0;
            const key = Math.round(v * 600) + '|' + sp.now;
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_value', [v]);
            x.c.uniform(x.ref, 'u_shiftNow', [sp.now ? 1 : 0]);
        } else if (w.type === 'segbar') {
            const v = this._raw(w.signal);
            const lit = isNum(v) ? Math.max(0, Math.min(w.max, Math.round(v))) : 0;
            if (!force && lit === x.last) return;
            x.last = lit;
            x.c.uniform(x.ref, 'u_lit', [lit]);
        } else if (w.type === 'revbar') {
            const rpm = this._raw('rpm'), sp = this._shift();
            const v = isNum(rpm) ? Math.round(Math.max(0, rpm) / 10) * 10 : 0;
            const peak = Math.round(this.score.peak / 10) * 10;
            const key = v + '|' + sp.rpm + '|' + peak + '|' + sp.now;
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_value', [v]);
            x.c.uniform(x.ref, 'u_shift', [sp.rpm]);
            x.c.uniform(x.ref, 'u_peak', [peak]);
            x.c.uniform(x.ref, 'u_shiftNow', [sp.now ? 1 : 0]);
        } else if (w.type === 'lights') {
            const rpm = this._raw('rpm'), sp = this._shift(), n = w.count || 12;
            // the lights fill from "from" rpm (3000) up to the shift point; a "from" at or past it means the last 500 rpm
            const from = Math.min(isNum(w.from) ? w.from : 3000, sp.rpm - 500);
            const lit = isNum(rpm) ? Math.floor(Math.min(1, Math.max(0, (rpm - from) / (sp.rpm - from))) * n) : 0;
            const key = lit + '|' + sp.now;
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_lit', [lit]);
            x.c.uniform(x.ref, 'u_strobe', [sp.now ? 1 : 0]);
        }
    }

    /** A rounded tag: fill in the tone colour (bright for a fresh grade), text centred on it. Empty text: nothing. */
    _paintBadge(w, s, tone, fresh) {
        const W = w.w, H = w.h, buf = Buffer.alloc(W * H * 4, 0);
        if (!s) return buf;
        const r = Math.min(6, H / 2), fillA = fresh ? 0.45 : 0.2;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                // rounded-rect coverage, 1 px soft edge
                const qx = Math.max(Math.abs(x + 0.5 - W / 2) - (W / 2 - r), 0), qy = Math.max(Math.abs(y + 0.5 - H / 2) - (H / 2 - r), 0);
                const cov = Math.min(1, Math.max(0, r + 0.5 - Math.sqrt(qx * qx + qy * qy)));
                if (cov <= 0) continue;
                const o = (y * W + x) * 4;
                buf[o] = tone[0]; buf[o + 1] = tone[1]; buf[o + 2] = tone[2]; buf[o + 3] = Math.round(255 * fillA * cov);
            }
        }
        const font = textRaster.loadFont(w.font);
        const ty = Math.round((H - font.metrics.cellHeight) / 2);
        const m = textRaster.mask(W, H, s, { font: w.font, align: 'center', spacing: w.spacing, offsetY: ty });
        const tc = fresh ? this.theme.fg : tone;
        for (let i = 0; i < m.length; i++) {
            if (!m[i]) continue;
            const a = m[i] / 255, o = i * 4, ba = buf[o + 3] / 255;
            const outA = a + ba * (1 - a);
            for (let c = 0; c < 3; c++) buf[o + c] = Math.round((tc[c] * a + buf[o + c] * ba * (1 - a)) / outA);
            buf[o + 3] = Math.round(outA * 255);
        }
        return buf;
    }

    /** "x/y" at every step, uploaded as small rects (not the whole, mostly empty, image). */
    _paintGridLabels(x) {
        const w = x.w, W = w.w, H = w.h, step = w.step || 100, font = w.font;
        const cell = textRaster.loadFont(font).metrics.cellHeight;
        const rects = [], parts = [];
        for (let gy = 0; gy < H; gy += step) {
            for (let gx = 0; gx < W; gx += step) {
                const label = (w.x + gx) + '/' + (w.y + gy);
                const lw = Math.min(W - gx - 2, textRaster.measure(label, font, 0) + 2);
                const lh = Math.min(H - gy - 2, cell);
                if (lw <= 0 || lh <= 0) continue;
                const buf = textRaster.drawText(lw, lh, label, { font, color: [255, 230, 0, 255] });
                rects.push({ x: gx + 2, y: gy + 2, w: lw, h: lh });
                parts.push(buf);
            }
        }
        this._blit(x, rects, Buffer.concat(parts));
    }

    _paintStripe(x) {
        const w = x.w, buf = Buffer.alloc(w.w * w.h * 4, 0);
        for (let px = 0; px < w.w; px++) {
            const c = M_STRIPE[Math.min(2, Math.floor(px * 3 / w.w))];
            for (let py = 0; py < w.h; py++) c.forEach((v, i) => { buf[(py * w.w + px) * 4 + i] = v; });
        }
        this._blit(x, null, buf);
    }

    _paintScale(x) {
        const w = x.w, n = this._barMax(w) / 1000 + 1, red = this.setting('redline');
        const m = Buffer.alloc(w.w * w.h, 0), hot = Buffer.alloc(w.w * w.h, 0);
        for (let i = 0; i < n; i++) {
            const label = String(i);
            const lw = textRaster.measure(label, w.font, 0);
            const cx = i / (n - 1) * w.w;
            const left = Math.round(Math.max(0, Math.min(w.w - lw, cx - lw / 2)));
            const one = textRaster.mask(w.w, w.h, label, { font: w.font, x: left });
            const into = w.redFrom && i * 1000 >= red ? hot : m;
            for (let k = 0; k < m.length; k++) if (one[k] > into[k]) into[k] = one[k];
        }
        const buf = textRaster.tint(m, w.w, w.h, { color: color(this.theme, w.color || 'dim'), font: w.font });
        if (w.redFrom) {
            const hb = textRaster.tint(hot, w.w, w.h, { color: this.theme.hot, font: w.font });
            for (let k = 0; k < hot.length; k++) if (hot[k]) hb.copy(buf, k * 4, k * 4, k * 4 + 4);
        }
        this._blit(x, null, buf);
    }
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function mib(bytes) { return (bytes / 1048576).toFixed(1) + ' MiB'; }

module.exports = HudApp;
