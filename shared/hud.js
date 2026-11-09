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
 *   rdash     effect layer; the whole Regal theme (shaders.js rdash), every box [x, y, w, h] in target px: "podL" (left pod frame,
 *             the right is its mirror), "podWin" (its gauge window), "ctr", "win1", "win2" (centre panel, its upper and lower windows),
 *             "vfdL", "vfdR", "spd" [needle pivot x, y, number row's middle y, mark row's y], "spdVirt" [height, half sweep deg] (where the
 *             numbers sit: on the rays of a far pivot that high below the number row; the needle turns to point at them) with "spdMax" (85 mph), "spdMid" (55, the middle), "spdStep" (5, between marks; the first mark) and "spdRest" (12: the needle's rest at 0, deg past the scale's start, under the row), "fuelG" / "podG" [pivot x, y,
 *             tick r0, r1], "podSignals" [{ signal, range, mid? }] x 2 (mid: the value at the middle mark), "led" with "ledN" and "rpmMax", "led2" (a yellow
 *             bar: "led2Signal" (boost) over "led2Range" ([0, 1.5]) in "led2N" (15) segments), "gearBox" + "gearPitch" (the lit
 *             box in the gear row P R N D _ n: D in D and S, the number in M), "lampB" (the parking brake / Auto Hold lamp, red / green; mirrored: the green CRUISE lamp), "arrow" [x, y, size], "batIcon" [x, y]
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
 *             (BMW draws bits of its own Sport view there), and "holeMask" [x, y, w, h] in target px: a rectangle in it
 *             kept black (BMW's speed-limit sign at the window's left edge); "holeFade" [x, y, w, h, feather (30), darkness
 *             (0.85)]: a rectangle darkened in it, fading out over feather px (behind the gear, so the map doesn't run through it); "stripSignals" [left, right] turns the strip
 *             into two bars filled from its middle out (blue left, red right) by those signals over "stripMax" [l, r]
 *             ([100, 10]), "stripHotWhen": "kickdown" draws the left bar's last tenth red in kickdown
 *             "gapGauge" { box: [x, y, w, h], max (150 m) }: the car ahead as an upright box filled from the bottom up to
 *             the gap, red while closing faster than config.acc.closingKmh (10 km/h); "routeStrip": true makes the strip the route's
 *             progress while guiding (travelled / (travelled + left), filled from the right end leftwards); "vbars" [{ box: [x, y, w, h], signal,
 *             range: [lo, hi], color }] (up to 2): more upright boxes like it (boost, battery)
 *   segbar    effect layer; "max" segments, the first round(signal) lit (e.g. "setupLevel:engine"), "slant" px,
 *             "gap" px between segments (8), "hotWhen": "kickdown" draws the last segment in "hotColor" (hot) while the
 *             pedal is in kickdown and the bar is full; "range" [lo, hi] maps the signal from that span onto 0..max
 *             (e.g. "boost" over [0, 1.5] bar, "batt12" over [0, 100] %)
 *   miku     effect layer; shaders.js miku, the Miku layout's standing character, from frames baked offline
 *             (tools/live2d_bake) and kept in the app's data folder (miku/, see _sprite); animated by the renderer's
 *             clock (time: true), so only a small u_drive uniform goes up when the smoothed g or the speed moves a step.
 *             "feet" [x, y] target px where the bake's "anchor" (between her feet) goes ([480, 377]). Nothing is drawn
 *             without frames (the status row says so)
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
 * "litGear": the Regal gear row slot (P 0 R 1 N 2 D 3, number 5) turns it "litColor" (fg) while lit.
 * Text "slide": { signal ("accGap" = the car ahead in m), max, yTop, yBottom }: the text's middle rides from yBottom (0)
 * to yTop (max) inside its box, blank without a value; "hotWhen": "closing" turns it red while the car ahead closes fast.
 * scale: "over" as revbar; "redFrom": true draws the numbers from the redline on in red.
 * lights: "count" (12), "from" rpm (3000) where the first light comes on, "tail" (0): the last "tail" lights are blue
 *   (the GT3 look); "round": true for dots;
 * "off" the alpha of an unlit light (0.14).
 * Text "colorBy": "verdict" colours it by the last shift's grade. Text "near": ["speed" | "rpm", i] turns it
 * "nearColor" (fg) while scale label i is the one nearest the value (BMW lights up the label by the needle); with
 * "nearFade": n it fades instead, from its own colour n label steps away to "nearColor" at the label (iDrive 8).
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
 * {{consumption}} {{u:cons}}: average consumption for the period picked on the center screen, in the units setting's unit (mpg or
 * l/100km, converted from the car's own; ResetLogic averageConsumption, scale / 10^digit, else bcDataAll's raw * config.consumption.factor 0.1).
 * {{fuelFull}} {{fuelHalf}} (the tank's full and half marks, config.tankLitres, in L or US gal) {{u:fuel}} (L / gal)
 * {{time}} {{ampm}} {{u:temp}} (°F / °C) {{gLat}} {{gLong}} (g, 2 decimals) {{signal:<car.data() key>}} (raw, 1 decimal).
 * The car ahead (de.bmw.dass.GapVehicleAhead; "--" without a car measured or data older than 3 s): {{accGap}} the gap in m / ft
 * ({{u:gap}}), from GapVehicleDrivingAhead gapVehicleDrivingAhead while its status says a car is measured (an X3 sends only
 * this one, once a second, 253 with nothing measured; DataFrontVehicle frontVehicleGapX when the car sends that), {{accRel}}
 * its speed against ours in km/h / mph ({{u:rel}}, minus = closing; "--" while we stand still): DataFrontVehicle frontVehicleSpeedX when sent,
 * else the gap's rate of change, smoothed. {{accSet}} the set speed BMW's HUD shows (DisplayDataServer cruiseCtrlSpeedHUD).
 * Regal: {{mph}} (mph whatever the units, unused by the layout), {{odometer}} (6 digits, km / mi; MileageSupreme), {{range4}} (4 digits), {{range3}} (up to 999, no leading zeros), {{u:distUc}} (MI, KM), {{u:consUc}} (L/100KM, MPG), {{ambientN}} (outside, no + sign),
 * {{lampBrake}} (PARK BRAKE / AUTO HOLD) {{lampTurnL}} {{lampTurnR}} {{lampCruise}} (the lamp's text while lit, else empty; config.lamps).
 * The route while guiding (Guidance finalDestinationInfo / travelledDistance, apps with "navLayout"; "--" else): {{navLeft}} the
 * distance left as BMW formats it, {{u:navLeft}} its unit (km, mi, m, ft), {{navTime}} the time left h:mm.
 * {{musicTitle}}: the song title BMW's player shows (app.json config.music; HmiMediaState playerMetadata, the line typed TITLE),
 * empty when nothing plays. A text widget with "font": "@sys" draws in the car's own font (any script, sysfont.js), "size" px.
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
const path = require('path');
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
const MIKU_MS = 16;              // the Miku character's own update rate (60 Hz)
const MIKU_TAU_MS = 450;        // the Miku character's speed follows the car this smoothly
const MIKU_LEAN_TAU_MS = 250;    // her lean eases toward the g this smoothly (no spring: no sway back past upright)
const MIKU_POINT_K = 70;         // the pointing arm's spring (1/s^2): about 1.3 Hz
const MIKU_IDLE_G = 0.03;        // below this |longitudinal g| the car idles: she glances around (the lean is not gated)
const MIKU_GLANCE_AFTER_MS = 1000; // the first glance this long after the car goes idle
const MIKU_LOOK_K = 30;          // the glance's spring (1/s^2): a turn of about half a second
const MIKU_LOOK_C = 11;          // critically damped: no overshoot
const MIKU_DOZE_AFTER_MS = 15000; // stopped and idle this long: she starts dozing
const MIKU_DOZE_PHASE_MS = 5000; // then dozes this long, wakes this long (glancing), dozes again, and so on
const MIKU_DROOP_W = 1.6;        // her droop's spring (rad/s, critically damped): about 3 s to the bottom
const MIKU_RISE_W = 3;           // waking in the loop: about 1.5 s
const MIKU_WAKE_W = 5;           // waking for good when the car moves: about 1 s
const MIKU_POINT_C = 16.7;       // critically damped: it rises and settles without bouncing

/**
 * The Miku shader for a widget and the "Miku parts" setting: leaving the glances and dozing, or (bare) everything
 * but the lean out of the shader altogether, to find what a display can't take. The layout's "idle": false does the
 * same as noIdle.
 */
function mikuShader(w, parts) {
    const noIdle = w.idle === false || parts === 'noIdle' || parts === 'bare';
    return (noIdle ? '#define MIKU_NO_IDLE\n' : '') + (parts === 'bare' ? '#define MIKU_BARE\n' : '') + shaders.miku;
}

/**
 * The Miku shader's tables as pixel rows to go under the atlas art: 56 entries of two values each, each entry a 3x3 px
 * block (so a bilinear read at its middle gets it whole), opaque (alpha 255: a canvas or driver that premultiplies
 * leaves it alone), each value 12 bits: (v + 1024) * 2 in R (high 8) and B's high or low nibble, in G likewise:
 * -1024 .. 1023.5 px in half px. Entries: 0-15 the lean frames' atlas x, y; 16-31 each lean frame's head shift x, y
 * (y: the forward/back lean's head drop; 0 sideways); 32-39 the glance frames' x, y; 40-47 each glance's head shift; 48-51 the doze frames' x, y; 52-55 each doze
 * frame's head shift x, y. Returns { px, rows, counts: { lean, look, doze } }.
 */
function mikuData(j, aw) {
    const xy = (v) => (Array.isArray(v) ? [Number(v[0]) || 0, Number(v[1]) || 0] : [0, 0]), num = (a, i) => (Array.isArray(a) && isNum(a[i]) ? a[i] : 0);
    const lean = Array.isArray(j.lean) && j.lean.length >= 3 ? j.lean.slice(0, 15) : [j.frames.idle];
    const look = Array.isArray(j.look) && j.look.length >= 3 && j.look.length % 2 ? j.look.slice(0, 7) : [];
    const doze = Array.isArray(j.doze) ? j.doze.slice(0, 4) : [];
    const e = [];
    for (let i = 0; i < 16; i++) e[i] = xy(lean[i]);
    for (let i = 0; i < 16; i++) e[16 + i] = [num(j.leanShift, i), num(j.leanShiftY, i)];
    for (let i = 0; i < 8; i++) { e[32 + i] = xy(look[i]); e[40 + i] = [num(j.lookShift, i), 0]; }
    for (let i = 0; i < 4; i++) { e[48 + i] = xy(doze[i]); e[52 + i] = xy(Array.isArray(j.dozeShift) ? j.dozeShift[i] : null); }
    const per = Math.floor(aw / 3), rows = Math.ceil(e.length / per) * 3, px = Buffer.alloc(aw * rows * 4, 0);
    const q = (v) => Math.max(0, Math.min(4095, Math.round((v + 1024) * 2)));
    e.forEach((v, i) => {
        const a = q(v[0]), b = q(v[1]), x0 = (i % per) * 3, y0 = Math.floor(i / per) * 3;
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
            const o = ((y0 + dy) * aw + x0 + dx) * 4;
            px[o] = a >> 4; px[o + 1] = b >> 4; px[o + 2] = ((a & 15) << 4) | (b & 15); px[o + 3] = 255;
        }
    });
    return { px, rows, counts: { lean: lean.length, look: look.length, doze: doze.length } };
}
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
// what BMW's media player shows (the center screen's instance), for {{musicTitle}}
const MEDIA = { iface: 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', instance: 'HMI_CID' };
const MEDIA_ITEM = { UNDEFINED: 0, ARTIST: 1, ALBUM: 2, TITLE: 3 };
// the trip computer's consumption unit (ResetLogicTypes.StatusUnitConsumptionBC)
const CONS_UNIT = { DEFAULT: 0, CONSUMPTION_KM: 1, CONSUMPTION_UK: 2, CONSUMPTION_US: 3, CONSUMPTION_KML: 4, CONSUMPTION_KGH2_100KM: 5, CONSUMPTION_KGH2_100MI: 6 };
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
// body.Light StatusFunctionsIndicators controlIndicateDirection (someip-interfaces.json)
const INDICATE = { BLINKEN_AUS: 0, TIPP_BLINKEN_LINKS_EIN: 1, TIPP_BLINKEN_RECHTS_EIN: 2, DAUER_BLINKEN_LINKS_EIN: 3,
    DAUER_BLINKEN_RECHTS_EIN: 4, BEIDSEITIGES_BLINKEN_EIN: 8, RESERVIERT_NICHT_VERFUEGBAR: 13, RESERVIERT_FEHLER: 14, SIGNAL_UNBEFUELLT: 15 };
// Guidance formattedDistance units (CommonTypes.DistanceUnit), by name or number
const ROUTE_UNIT = { KM: 'km', METER: 'm', MILE_US: 'mi', MILE_UK: 'mi', FEET: 'ft', YARD: 'yd', 0: 'ft', 1: 'km', 2: 'm', 3: 'mi', 4: 'mi', 6: 'yd' };
// the Regal theme's gear row: P R N D, a gap, the gear number; the lit box for each selector state (S lights D, M the number)
// the parking brake and Auto Hold (Vehicle2 statusStandstillFunctions, VehicleStabilizationManagement StandStillFunction, CDS
// statusHandBrake; someip-interfaces.json)
const PARK_BRAKE = { PARKBREMSE_MECHANISCH_NICHT_FESTGESTELLT: 0, PARKBREMSE_MECHANISCH_FESTGESTELLT: 1, PARKBREMSE_IM_STELLVORGANG_LOESEN: 2,
    PARKBREMSE_IM_STELLVORGANG_FESTSTELLEN: 4, FUNKTIONSSCHNITTSTELLE_IST_NICHT_VERFUEGBAR: 13, FUNKTION_MELDET_FEHLER: 14, SIGNAL_UNBEFUELLT: 15 };
const AUTO_H = { AUTOH_NICHT_AKTIVIERT: 0, AUTOH_AKTIVIERT_UND_HAELT_FAHRZEUG_NICHT: 1, AUTOH_AKTIVIERT_UND_HAELT_FAHRZEUG: 2, SIGNAL_UNBEFUELLT: 3 };
const HAND_BRAKE = { NICHT_CODIERT: 0, HANDBREMSE_GELOEST: 1, HANDBREMSE_ANGEZOGEN: 2, SIGNAL_UNGUELTIG: 3 };
const REGAL_GEARS = { P: 0, R: 1, N: 2, D: 3, S: 3, M: 5 };
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
        this.turn = null;                // the indicators: 'L', 'R', 'LR' (hazards) or '' (body.Light StatusFunctionsIndicators)
        this.accOn = false;              // BMW's HUD has the ACC car or distance bars up (the Regal CRUISE lamp)
        this.mileage = null;             // the odometer as sent (MileageSupreme, taken as km)
        this.parkBrake = null;           // the parking brake set (true / false), null until the car says
        this.parkBrakeCds = null;        // the same from CDS statusHandBrake (a fallback)
        this.autoHold = null;            // Auto Hold: 'hold' (holding the car), 'armed', 'off', null until the car says
        this.volt12 = null; this.volt12At = 0;   // V, the 12 V system from the engine unit
        this.needsVolt = false;          // a shown widget uses volt12 (the engine unit is only asked then)
        this.pedalLogged = 0;
        this.pedalObd = null; this.pedalObdAt = 0; this.pedalObdLogged = null;   // %, the pedal from the engine unit (OBD PID 0x49)
        this.needsPedal = false;         // a shown widget uses the throttle (the engine unit is only asked then)
        this.decelF = null; this.decelAt = 0;   // g, the smoothed deceleration for the brake bar
        this.carOffsetMin = null;        // the car's time zone, minutes from UTC, from the time the cluster shows
        this.battRaw = null; this.battAt = 0;   // the 12 V battery's charge condition as sent
        this.aheadLogged = {};
        this.accSetRaw = null;           // cruiseCtrlSpeedHUD as sent
        this.aheadLogAt = {};
        this.carUnits = { press: null, temp: null, psiSeen: false };   // the car's display units, for the TPMS values
        this.program = null;             // 'S' / 'M' from the MDrive gearbox display, else null (D)
        this.fuelL = null; this.rangeKm = null; this.ambient = null;   // KombiIF tank / range, outside temperature
        this.tyres = { p: {}, t: {} };                                  // TPMS pressure (bar) and temperature (C) per corner FL FR RL RR
        this.activeName = null;          // the layout shown now ('off' = nothing)
        this.pixelBytes = 0;             // what the layout's image layers and glyph atlases cost of cluster-render's pixel memory
        this.atlases = new Map();        // "<conn>:<font>" -> glyph atlas { ref, c, ci, cols, rows, cellW, cellH, chars, bytes } (R8), "sprite:..." -> the Miku frames (_sprite); assets kept across rebuilds
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
        // while the "navLayout" switch is in force the map window is open, whatever "mapWindow" says
        if (key === 'mapWindow' && this._navSwitch()) return true;
        const s = this.ctx.settings.item(key);
        const v = this.ctx.settings.get(key);
        if (!s) return v;
        // a choice that was renamed or replaced (app.json config.choiceAliases, e.g. the HUD's Redline layout is now Miku)
        const alias = s.type === 'choice' && this.config.choiceAliases && this.config.choiceAliases[v];
        if (alias && (s.options || []).some((o) => o[0] === alias)) return alias;
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
            // the trip computer for the period picked on the center screen (this trip, since refuelling, individual, long term):
            // average consumption (app.json config.consumption); raw values logged on change to check the scaling
            'de.bmw.infotainment.resetlogic.ResetLogic': {
                averageConsumption: (v) => {
                    if (!v) return;
                    const sc = v.consumptionCombustionCurrentScale, dg = v.consumptionCombustionCurrentDigit;
                    this.consAvg = isNum(sc) && sc < 65535 && isNum(dg) && dg >= 0 && dg <= 3 ? sc / Math.pow(10, dg) : null;
                    this.consUnit = enumNum(v.combustionUnit, CONS_UNIT);
                    this.consAt = Date.now();
                    this._logCons('average', v);
                },
                bcDataAll: (v) => {
                    if (!v) return;
                    const d = v.bcData || {};
                    this.consPeriod = d.resetOption !== undefined ? d.resetOption : v.activeResetLogic;
                    this.consBc = isNum(d.consumptionAverage) && d.consumptionAverage < 65535 ? d.consumptionAverage : null;
                    if (v.bcUnits && v.bcUnits.consumption !== undefined) this.consUnitBc = enumNum(v.bcUnits.consumption, CONS_UNIT);
                    this.consBcAt = Date.now();
                    this._logCons('bc', { period: this.consPeriod, active: v.activeResetLogic, avg: d.consumptionAverage, now: d.currentConsumption, speed: d.speedAverage, units: v.bcUnits });
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
                    // 4093..4095 are "no object / not available" codes (with no car ahead an X3 sends 4093 in every field and
                    // object id 253, Nov 8 2026), as 253..255 are for the object id
                    const num = (x) => (isNum(x) && x < 4093 ? x : null);
                    const id = v.frontVehicleObjectID, none = !isNum(id) || id >= 253;
                    this.ahead = { gapX: none ? null : num(v.frontVehicleGapX), gapY: none ? null : num(v.frontVehicleGapY),
                        speedX: none ? null : num(v.frontVehicleSpeedX), speedY: none ? null : num(v.frontVehicleSpeedY),
                        q: v.qualifierEventDataFunctionFrontVehicle, at: Date.now() };
                    this._logAhead('front', v);
                },
                GapVehicleDrivingAhead: (v) => {
                    if (!v) return;
                    const g = v.gapVehicleDrivingAhead, m = enumNum(v.statusMeasurementVehicleDrivingAhead, AHEAD2_MEASURED);
                    this.ahead2 = { gap: isNum(g) && g < 253 ? g : null, q: v.qualifierFunctionVehicleDrivingAhead, measured: m >= 1 && m <= 4, at: Date.now() };
                    this._gapRate();
                    this._logAhead('gap', v);
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
                // the hand brake contact (a fallback for the parking brake lamp): 2 set, 1 released
                statusHandBrake: (v) => {
                    const n = enumNum(v && v.statusContactHandBrake, HAND_BRAKE);
                    this.parkBrakeCds = n === 2 ? true : n === 1 ? false : null;
                },
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
                // the indicators (the Regal theme's turn lamps): controlIndicateDirection 1 / 3 left, 2 / 4 right, 8 hazards
                StatusFunctionsIndicators: (v) => {
                    const raw = v && v.controlIndicateDirection, d = enumNum(raw, INDICATE);
                    const t = d === 1 || d === 3 ? 'L' : d === 2 || d === 4 ? 'R' : d === 8 ? 'LR' : d === 0 ? '' : null;
                    if (t !== this.turn) this.log.info('indicators raw ' + raw + (v && v.activeFunctionIndicateDirection !== undefined ? ' / ' + v.activeFunctionIndicateDirection : ''));
                    this.turn = t; this.turnAt = Date.now();
                },
            },
            // the parking brake (the Regal theme's left lamp): statusParkingBrake 1 / 4 = set or setting, 0 / 2 = released
            'de.bmw.infotainment.vehicle.Vehicle2': {
                statusStandstillFunctions: (v) => {
                    const raw = v && v.statusParkingBrake, n = enumNum(raw, PARK_BRAKE);
                    const on = n === 1 || n === 4 ? true : n === 0 || n === 2 ? false : null;
                    if (on !== this.parkBrake) this.log.info('parking brake raw ' + JSON.stringify(v));
                    this.parkBrake = on;
                },
            },
            // Auto Hold (the same lamp, green): statusAutoH 2 = on and holding the car, 1 = on, 0 = off
            'de.bmw.chassis.VehicleStabilizationManagement': {
                StandStillFunction: (v) => {
                    const raw = v && v.statusAutoH, n = enumNum(raw, AUTO_H);
                    const h = n === 2 ? 'hold' : n === 1 ? 'armed' : n === 0 ? 'off' : null;
                    if (h !== this.autoHold) this.log.info('auto hold raw ' + raw + ', parking brake ' + (v && v.statusParkingBrake));
                    this.autoHold = h;
                    // this message carries the parking brake too, when Vehicle2 has not said
                    const pb = enumNum(v && v.statusParkingBrake, PARK_BRAKE);
                    if (this.parkBrake === null && (pb === 0 || pb === 1 || pb === 2 || pb === 4)) this.parkBrakeVsm = pb === 1 || pb === 4;
                },
            },
            // the odometer (the Regal theme's VFD): MileageSupreme, unit unconfirmed (taken as km; logged raw on change)
            'de.bmw.infrastructure.MileageSupreme': {
                mileageSupreme: (v) => {
                    const m = v && v.mileageSupreme;
                    const km = isNum(m) && m > 0 && m < 0xFFFFFF ? m : null;
                    if (km !== this.mileage) this.log.info('odometer raw ' + JSON.stringify(v));
                    this.mileage = km;
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
        if (!this._modesOn() && this.config.lamps !== true) delete extra['de.bmw.infotainment.displaydataserver.DisplayDataServer'];
        if (this.config.lamps !== true) {
            delete extra['de.bmw.infrastructure.MileageSupreme']; delete extra['de.bmw.infotainment.vehicle.Vehicle2'];
            delete extra['de.bmw.chassis.VehicleStabilizationManagement'];
            if (extra['de.bmw.infotainment.vehicle.CDS']) delete extra['de.bmw.infotainment.vehicle.CDS'].statusHandBrake;
        }
        if (!this._modesOn() && this.config.carAhead !== true) delete extra['de.bmw.dass.GapVehicleAhead'];
        if (!this.config.consumption) delete extra['de.bmw.infotainment.resetlogic.ResetLogic'];
        if (this.config.pedals !== true) {
            delete extra['de.bmw.powertrain.AcceleratorPedal'];
            if (this.config.lamps === true) delete extra['de.bmw.infotainment.vehicle.CDS'].statusBattery2; else delete extra['de.bmw.infotainment.vehicle.CDS'];
        }
        if (this.config.pedals !== true && this.config.lamps !== true) {
            // the indicators alone (config.indicators: the Miku character points that way)
            if (this.config.indicators === true) delete extra['de.bmw.body.Light'].LampExterior;
            else delete extra['de.bmw.body.Light'];
        }
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
        c.on('target', (name, state, holder, reason, guideOff, disabled) => {
            if (name !== this.target) return;
            this.targetState = { state, holder, reason, disabled: !!disabled };
            this.log.info('target ' + name + tag + ' ' + state + (holder ? ' (holder ' + holder + ')' : '') + (reason ? ': ' + reason : '') +
                (disabled ? ' (disabled by cluster-render\'s mapping guard: two strikes; as root: /var/opt/cluster-render/current/cluster-render -c /var/opt/cluster-render/current/cluster-render.conf guard-reset)' : ''));
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
        this._startMedia();
    }

    /** HUD modes only on the HUD, in apps that have the "makeRoom" setting. */
    _modesOn() { return this.target === 'hud' && !!this.ctx.settings.item('makeRoom'); }

    /** BMW's route guidance on / off, for the HUD modes. */
    _startNav() {
        if (!this._modesOn() && !this.ctx.settings.item('navLayout')) return;
        const h = { guidanceState: (v) => this._guard('guidance', () => this._onGuidance(v)) };
        if (this.ctx.settings.item('navLayout')) {
            // the route's progress (Sport's route bar): distance and time left to the final destination, distance travelled
            h.finalDestinationInfo = (v) => this._guard('route', () => this._onRouteInfo(v));
            h.travelledDistance = (v) => this._guard('route', () => this._onTravelled(v));
        }
        Promise.resolve().then(() => this.ctx.signals.watch(GUIDANCE.iface, GUIDANCE.instance, h, this.log)).then((s) => {
            this.navSub = s;
            this.log.info('signal Guidance ' + (s && s.error ? 'error: ' + s.error : 'subscribed'));
        }).catch((e) => this.log.info('route guidance not available: ' + (e && e.message || e)));
    }

    /** The song title BMW's player shows (app.json config.music), for {{musicTitle}}. */
    _startMedia() {
        if (!this.config.music) return;
        this.media = { pm: null, mm: null, tracks: null, sel: null };
        const on = (k) => (v) => this._guard('media', () => { this.media[k] = v && typeof v === 'object' ? v : null; this._pickTitle(k); });
        Promise.resolve().then(() => this.ctx.signals.watch(MEDIA.iface, MEDIA.instance, {
            playerMetadata: on('pm'), mainMenuMetadata: on('mm'), tracks: on('tracks'), trackSelection: on('sel'),
        }, this.log)).then((s) => {
            this.mediaSub = s;
            this.log.info('signal HmiMediaState ' + (s && s.error ? 'error: ' + s.error : 'subscribed'));
        }).catch((e) => this.log.info('media metadata not available: ' + (e && e.message || e)));
        // load the font now, not on the first title's paint (the search walks folders once)
        this.fontT = setTimeout(() => this._guard('font', () => this._sysFont()), 2000);
    }

    /** The title, from HmiMediaState: playerMetadata's line typed TITLE; else (the car's player sends only ARTIST and
     *  ALBUM there, "Aimer" / "Sleepless Nights", Nov 9 2026) the playing track's entry in the track list (by trackId,
     *  its first line), or mainMenuMetadata's first line that isn't the artist or album; else an untyped playerMetadata
     *  line (the second first); else the artist. Each source's raw text is logged when it changes, to confirm on the car. */
    _pickTitle(changed) {
        const m = this.media, pm = m.pm || {};
        const clean = (x) => String(x || '').replace(/\s+/g, ' ').trim();
        const kind = (ty) => {
            const n = enumNum(ty, MEDIA_ITEM);
            if (n >= 0 && n !== null) return n;
            const u = String(ty || '').toUpperCase();
            return /TITLE/.test(u) ? MEDIA_ITEM.TITLE : /ARTIST/.test(u) ? MEDIA_ITEM.ARTIST : /ALBUM/.test(u) ? MEDIA_ITEM.ALBUM : 0;
        };
        const lines = [[clean(pm.firstLineText), kind(pm.firstLineType)], [clean(pm.secondLineText), kind(pm.secondLineType)]];
        const other = lines.filter((l) => l[0] && (l[1] === MEDIA_ITEM.ARTIST || l[1] === MEDIA_ITEM.ALBUM)).map((l) => l[0]);
        const fresh = (x) => x && other.indexOf(x) < 0;
        // the raw sources, logged once per change
        const id = m.sel && m.sel.selectedTrackId !== undefined ? m.sel.selectedTrackId : pm.trackId;
        const list = m.tracks && Array.isArray(m.tracks.tracks) ? m.tracks.tracks : [];
        const tr = id !== undefined ? list.find((t) => t && String(t.trackId) === String(id)) : null;
        const mm = m.mm ? [clean(m.mm.firstLineText), clean(m.mm.secondLineText), clean(m.mm.thirdLineText)] : null;
        const raw = JSON.stringify({ track: tr ? [clean(tr.firstLine), clean(tr.secondLine)] : null, id: id, of: list.length, menu: mm });
        if (raw !== this.mediaRaw) { this.mediaRaw = raw; this.log.info('media sources (' + changed + '): ' + raw); }
        let t = '', from = '';
        const typed = lines.find((l) => l[0] && l[1] === MEDIA_ITEM.TITLE);
        if (typed) { t = typed[0]; from = 'player TITLE'; }
        if (!t && tr) {
            const c = [clean(tr.firstLine), clean(tr.secondLine)].find(fresh);
            if (c) { t = c; from = 'track list'; }
        }
        if (!t && mm) {
            const c = mm.find(fresh);
            if (c) { t = c; from = 'main menu'; }
        }
        if (!t) {
            const u = [lines[1], lines[0]].find((l) => l[0] && l[1] !== MEDIA_ITEM.ARTIST && l[1] !== MEDIA_ITEM.ALBUM);
            if (u) { t = u[0]; from = 'player line'; }
        }
        if (!t) { t = lines[0][0]; from = t ? 'artist (no title anywhere)' : 'nothing'; }
        if (t !== this.musicTitle) this.log.info('now playing ' + JSON.stringify(t) + ' from ' + from + ' (player lines ' + JSON.stringify(lines) + ', uiType ' + JSON.stringify(pm.uiType) + ')');
        this.musicTitle = t;
    }

    /** The car's own font for text in any script (app.json config.music.fonts: paths tried in order, a fallback chain);
     *  null when none of them loads. */
    _sysFont() {
        if (this.sysFontTried) return this.sysFont;
        this.sysFontTried = true;
        const m = this.config.music || {};
        const sysfont = require('./sysfont');   // only in apps that ship it (app.json "shared")
        this.sysFont = sysfont.open(m.fonts || [], this.log);
        if (!this.sysFont && Array.isArray(m.searchIn)) {
            // none of the listed files: look for the car's own fonts, and log them all so the paths can go in config
            const r = sysfont.find(m.searchIn, m.searchMax, m.searchMaxBytes, this.log);
            this.log.info('font files found (' + r.all.length + '): ' + r.all.slice(0, 60).map((f) => f.path + ' ' + Math.round(f.size / 1024) + ' KiB').join(', '));
            this.sysFont = r.fonts;
        }
        if (!this.sysFont) this.log.info('no system font found (config.music.fonts / searchIn): the music title stays blank');
        return this.sysFont;
    }

    /** finalDestinationInfo: distance left (formattedDistance: BMW's text, its unit, rawDistance), time left (travelTime, s). */
    _onRouteInfo(v) {
        if (!v || typeof v !== 'object') return;
        const fd = v.formattedDistance || {};
        const raw = isNum(fd.rawDistance) ? fd.rawDistance : isNum(v.distanceFromCurrentToFinalDestination) ? v.distanceFromCurrentToFinalDestination : null;
        this.route = Object.assign(this.route || {}, {
            leftRaw: raw, leftText: typeof fd.distance === 'string' ? fd.distance.trim() : null, leftUnit: fd.unit,
            timeLeft: isNum(v.travelTime) && v.travelTime >= 0 && v.travelTime < 0xFFFFFFFF ? v.travelTime : null, at: Date.now(),
        });
        // without a travelled distance, the route's length is the most left seen since guidance started
        if (isNum(raw)) this.route.startRaw = Math.max(this.route.startRaw || 0, raw);
        this._logRoute('destination', { distance: fd, travelTime: v.travelTime, delayTime: v.delayTime, delayStatus: v.delayStatus,
            distanceFromCurrentToFinalDestination: v.distanceFromCurrentToFinalDestination });
    }

    /** travelledDistance (FormattedDistance): how far along the route we are, for the bar's total (travelled + left). */
    _onTravelled(v) {
        if (!v || typeof v !== 'object') return;
        this.route = Object.assign(this.route || {}, { doneRaw: isNum(v.rawDistance) ? v.rawDistance : null });
        this._logRoute('travelled', v);
    }

    /** Route messages as sent, each when it changes, at most every 10 s (to confirm the units on the car). */
    _logRoute(kind, v) {
        const now = Date.now(), line = JSON.stringify(v);
        this.routeLogged = this.routeLogged || {}; this.routeLogAt = this.routeLogAt || {};
        if (line === this.routeLogged[kind] || now - (this.routeLogAt[kind] || 0) < 10000) return;
        this.routeLogged[kind] = line; this.routeLogAt[kind] = now;
        this.log.info('route ' + kind + ' raw ' + line);
    }

    /** The route's progress 0..1 (travelled / (travelled + left), else 1 - left / the most left seen), null when not guiding
     *  or not known. */
    _routeProgress() {
        const r = this.route;
        if (!this.navActive || !r || !isNum(r.leftRaw)) return null;
        if (isNum(r.doneRaw) && r.doneRaw + r.leftRaw > 0) return Math.min(1, Math.max(0, r.doneRaw / (r.doneRaw + r.leftRaw)));
        return r.startRaw > 0 ? Math.min(1, Math.max(0, 1 - r.leftRaw / r.startRaw)) : null;
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
        if (on) this.route = null;               // a new route: its length starts over
        if (this.ctx.settings.item('navLayout') && this._layoutName() !== this.activeName) {
            this.log.info('route guidance ' + (on ? 'on' : 'off') + ': layout ' + this._layoutName());
            this._rebuild();
            return;
        }
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
        this.accOn = !!car || !!bars;
        const on = (!!sym && !!col) || !!car || !!bars || (!!wheel && wheel !== STA_WHEEL.LDM_STW_GREY);
        if (on === this.assistActive) return;
        this.assistActive = on;
        this._modeChanged();
    }

    /** The car-ahead messages as sent, when they change (an X3 repeats the same one every second), at most once a second,
     *  for calibrating config.acc against what BMW's HUD shows. */
    _logAhead(kind, v) {
        const now = Date.now(), line = JSON.stringify(v);
        this.aheadLogged = this.aheadLogged || {}; this.aheadLogAt = this.aheadLogAt || {};
        if (line === this.aheadLogged[kind] || now - (this.aheadLogAt[kind] || 0) < 1000) return;   // each message on its own
        this.aheadLogged[kind] = line; this.aheadLogAt[kind] = now;
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
            // DataFrontVehicle's speed only once config.acc.rel says how to read it (use: true): following a car slowly on an
            // X3 it read 509, not a relative km/h; until then the gap's rate
            const cr = (this.config.acc && this.config.acc.rel) || {};
            if (cr.use === true && a && now - a.at < FRESH_MS && enumNum(a.q, AHEAD_Q) !== AHEAD_Q.EVENT_DATA_NOT_AVAILABLE && isNum(a.speedX)) return this._accScale('rel', a.speedX);
            const r = this.relFromGap;
            return r && isNum(r.v) && now - r.at < FRESH_MS && isNum(this._gapM()) ? r.v : null;
        }
        if (key === 'set') return this.assistActive && isNum(this.accSetRaw) && this.accSetRaw !== 65535 ? this._accScale('set', this.accSetRaw) : null;
        return null;
    }

    /** Average consumption for the period picked on the center screen, in the car's unit; null before the car sends it.
     *  The last value stands until the next: the car notifies it only when it changes (a 2-minute timeout here showed
     *  "--" on the car, Nov 9 2026). */
    _consumption() {
        let v = null;
        if (isNum(this.consAvg)) v = this.consAvg;
        else if (isNum(this.consBc)) {
            const c = this.config.consumption || {};
            v = this.consBc * (isNum(c.factor) ? c.factor : 0.1) + (isNum(c.offset) ? c.offset : 0);
        } else return this.car.data().demo ? (this.setting('units') === 'us' ? 235.215 / 9.8 : 9.8) : null;
        // the car sends it in its own unit: to l/100km, then to the units setting's (mpg US or l/100km)
        const u = isNum(this.consUnit) && this.consUnit > 0 ? this.consUnit : this.consUnitBc;
        const l100 = !(v > 0) ? null : u === CONS_UNIT.CONSUMPTION_US ? 235.215 / v : u === CONS_UNIT.CONSUMPTION_UK ? 282.481 / v
            : u === CONS_UNIT.CONSUMPTION_KML ? 100 / v : v;
        if (!isNum(l100)) return null;
        return this.setting('units') === 'us' ? 235.215 / l100 : l100;
    }

    /** The consumption's unit label, by the units setting: mpg (US) or l/100km. */
    _consUnit() { return this.setting('units') === 'us' ? 'mpg' : 'l/100km'; }

    _logCons(kind, v) {
        const line = JSON.stringify(v);
        this.consLines = this.consLines || {};
        if (this.consLines[kind] === line) return;
        this.consLines[kind] = line;
        this.log.info('consumption ' + kind + ' raw ' + line);
    }

    /** The car ahead getting closer faster than config.acc.closingKmh (10 km/h). */
    _closing() {
        const r = this._acc('rel'), lim = this.config.acc && isNum(this.config.acc.closingKmh) ? this.config.acc.closingKmh : 10;
        return isNum(r) && r < -lim;
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
        if (this.mediaSub) this.mediaSub.shutdown();
        clearTimeout(this.fontT);
        this.widgets.forEach((x) => { if (x.timer) clearInterval(x.timer); });
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

    /**
     * The Miku layout's baked frames: <data>/miku/atlas.json and (miku-fb/ for the forward/back lean)
     * atlas.rgba (straight-alpha RGBA, atlas[0] x atlas[1] px), made by tools/live2d_bake and pushed by
     * scripts/deploy.sh --miku. They are not in the app: the character's art stays with its owner. Uploaded once as an
     * RGBA asset per connection and kept in this.atlases (so the pixel memory counts it); new files (a later bake)
     * drop the old asset. Null, with this.problem set, when the files are missing or bad.
     */
    _sprite(w, ci) {
        // the "Miku lean" setting picks the bake: sideways (miku/) or forward/back (miku-fb/). Switching it rebuilds
        // the layout, and the other folder's files replace the uploaded atlas (one Miku atlas a connection at a time)
        // Custom Cluster's lying Miku (mikuLie) has her own bake, miku-lie/, and no table rows
        const lie = w.type === 'mikuLie', fb = !lie && this.setting('mikuLean') === 'fb';
        const sub = lie ? 'miku-lie' : fb ? 'miku-fb' : 'miku', dir = path.join(this.ctx.dataDir || '.', sub);
        let st;
        try { st = fs.statSync(path.join(dir, 'atlas.rgba')); } catch (e) { st = null; }
        const pre = (lie ? 'lie:' : 'sprite:') + ci + ':', key = pre + dir + ':' + (st ? st.mtimeMs : 0);
        if (this.atlases.has(key)) return this.atlases.get(key);
        this.atlases.forEach((a, k) => {
            if (k.indexOf(pre) === 0) { a.c.drop(a.ref); this.atlases.delete(k); }
        });
        try {
            if (!st) throw new Error('no baked frames in ' + dir + ' (tools/live2d_bake, then scripts/deploy.sh --' + sub + ')');
            const info = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf8'));
            const [aw, ah] = info.atlas || [];
            if (!(aw > 0 && ah > 0)) throw new Error('atlas.json: bad "atlas" size');
            // the instrument cluster (KOMBI) restarted on a 1024x1128 RGBA asset (Nov 2026): nothing over 1024 a side
            if (aw > 1024 || ah > 1024) throw new Error('atlas ' + aw + 'x' + ah + ' is over 1024 px a side, which restarts the instrument cluster; bake again with the current tools/live2d_bake');
            if (!info.frames || !info.frames.idle || !Array.isArray(info.frame) || !Array.isArray(info.anchor)) throw new Error('atlas.json: needs "frame", "anchor" and frames.idle');
            const art = fs.readFileSync(path.join(dir, 'atlas.rgba'));
            if (art.length !== aw * ah * 4) throw new Error('atlas.rgba is ' + art.length + ' bytes, ' + aw + 'x' + ah + ' RGBA needs ' + aw * ah * 4);
            // the per-frame tables go in a few rows under the art, which the shader reads (mikuData), not in uniforms
            if (lie !== (info.pose === 'lie')) throw new Error(lie ? 'atlas.json is not a lying bake (config "pose": "lie")' : 'atlas.json is the lying bake (for Custom Cluster): bake the standing one');
            const data = lie ? { px: Buffer.alloc(0), rows: 0, counts: {} } : mikuData(info, aw), h = ah + data.rows;
            if (h > 1024) throw new Error('atlas ' + aw + 'x' + ah + ' leaves no room under 1024 px for its ' + data.rows + ' rows of tables; bake again with the current tools/live2d_bake');
            const px = Buffer.concat([art, data.px]);
            const c = this._clientAt(ci);
            const ref = c.asset({ target: this.target, format: 'rgba8', w: aw, h, sampling: 'bilinear' });
            if (!ref) throw new Error('atlas asset refused (' + aw + 'x' + h + ')');
            c.pixels(ref, null, px);
            const a = { ref, c, ci, info, size: [aw, h], dataY: ah, counts: data.counts, bytes: aw * h * 8 };
            this.atlases.set(key, a);
            this.log.info('miku frames: ' + Object.keys(info.frames).length + ' of ' + info.frame.join('x') + ', ' +
                (info.tails ? 'tails, ' : '') + aw + 'x' + h + ' RGBA asset, ' + mib(a.bytes) + ' of pixel memory');
            return a;
        } catch (e) {
            this.problem = (lie ? 'Lying Miku: ' : 'Miku: ') + e.message;
            this.log.warn('widget "' + w.id + '": ' + e.message);
            return null;
        }
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
    onStatus(fn) { this.statusListeners.push(fn); if (this.lastStatus) fn(this.lastStatus, this.lastDetail || ''); }

    /** The "navLayout" switch is in force: the app has that setting (the cluster), it names a layout, and BMW is guiding. */
    _navSwitch() {
        if (!this.navActive || !this.ctx.settings.item('navLayout')) return false;
        const v = this.setting('navLayout');
        return !!v && v !== 'same';
    }

    /** The layout name to show now: the "navLayout" one while guiding, else per drive mode when that's on and known (apps
     *  with "byMode"), else the plain setting. */
    _layoutName() {
        if (this._navSwitch()) return this.setting('navLayout');
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
        // cluster-render's mapping guard turned this target off (two display restarts right after its mappings); it stays
        // off, even across reboots, until cluster-render's guard-reset as root (cluster-render README, the mapping guard;
        // the full command is in the log line above). The vendored client passes the flag since 0.1.13
        if (ts && ts.disabled) return ', off: cluster-render\'s guard disabled this display after 2 strikes (reset it as root: guard-reset)';
        if (ts && (ts.state === 'waiting' || ts.state === 'parked') && ts.holder) {
            // holder "none" is no BMW content: on iDrive 7 it is the cluster panel holding the scene id the HUD shares
            // ("scene id in use by another target"); a stock holder says which wait it is (a pop-up or guidance, or the slot)
            if (ts.holder === 'foreign') return ', waiting: another app has this display';
            if (ts.holder === 'stock') return ', waiting: BMW is using this display' + (ts.reason && ts.reason !== 'slot in use' ? ' (' + ts.reason + ')' : '');
            if (/scene id in use/.test(ts.reason || '')) return ', waiting: the cluster layout has the scene the HUD shares';
            return ', waiting' + (ts.reason ? ': ' + ts.reason : '');
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
        const mode = this._navSwitch() ? ' (navigating)' : byMode ? (this.driveMode ? ' (' + MODE_NAME[this.driveMode] + ')' : ' (drive mode not seen yet)') : '';
        const what = this.target === 'panel' ? 'cluster' : 'HUD';
        if (this.activeName === 'off' && this.modeOff) return this.label + ' off while ' + MODE_TEXT[this.activeMode] + ' shows' + mode;
        if (this.activeName === 'off') return this.label + ' off' + mode + ": BMW's own " + what + ' shows';
        const name = this._layoutLabel(this.activeName);
        const d = this.car.data();
        const demo = d.demo ? ', demo data' : '';
        const conns = this._connCount();
        const layers = ', ' + this._layerCount(this._layerRefs().length) + (conns > 1 ? ' on ' + conns + ' connections' : '')
            + (this.pixelBytes ? ', ' + mib(this.pixelBytes) + ' of 16 MiB pixels' : '')
            + (this.activeMode !== 'normal' ? ', ' + this.activeMode + ' mode' : '');
        if (this.layoutTheme) return this.label + ' on' + mode + ': ' + name + ' theme' + layers + demo;
        const theme = THEMES[this.themeName] ? THEMES[this.themeName].name : this.themeName;
        const auto = this.setting('hudTheme') === 'auto' ? ' (Auto)' : '';
        return this.label + ' on' + mode + ': ' + name + ' layout, ' + theme + ' theme' + auto + layers + demo;
    }

    /** The status page's second row: why layers aren't drawn ("Waiting: BMW is using this display", "3 of 5 drawn (...)",
     *  "Refused ..."), "" when all is drawn or nothing shows. */
    statusDetail() {
        if (!this.client.ready || this.problem || this.activeName === 'off') return '';
        const n = this._drawnNote().replace(/^, /, '');
        return n ? n.charAt(0).toUpperCase() + n.slice(1) : '';
    }

    _status() {
        const s = this.statusText(), d = this.statusDetail();
        if (s === this.lastStatus && d === this.lastDetail) return;
        this.lastStatus = s; this.lastDetail = d;
        this.statusListeners.forEach((fn) => { try { fn(s, d); } catch (e) { this.log.warn('status listener: ' + e); } });
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
        // the demo drive: made up from the throttle, building from 1500 to 3500 rpm (up to 1.3 bar)
        const d = this.car.data();
        if (d.demo && isNum(d.throttle) && isNum(d.rpm)) return Math.max(0, d.throttle) * 1.3 * Math.min(1, Math.max(0, (d.rpm - 1500) / 2000));
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
        if (name === 'batt12') return this._batt12();
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

    /** The pedal in kickdown: the OBD pedal at or past config.pedal.kickdown (87 %: an X3 M40i reads 82 flat out and 91 in
     *  kickdown); the demo drive's at full throttle. */
    _kickdown() {
        const c = this.config.pedal || {};
        if (c.source === 'obd' && isNum(this.pedalObd) && Date.now() - this.pedalObdAt < 1000) return this.pedalObd >= (isNum(c.kickdown) ? c.kickdown : 87);
        const d = this.car.data();
        return !!d.demo && isNum(d.throttle) && d.throttle >= 1;
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

    /** The Regal lamps. Brake: the brake lights (the demo drive: while slowing). Turn: blinking at 1.25 Hz while the car says
     *  that side (hazards: both); the demo drive blinks left now and then. Cruise: BMW's ACC car or bars up. */
    /** The Regal left lamp: 'park' (the parking brake set: red PARK BRAKE), 'hold' (Auto Hold holding the car: green AUTO
     *  HOLD) or null. The demo drive: parked in P, holding at a standstill otherwise. */
    _brakeLamp() {
        const known = (x) => x === true || x === false;
        const pb = known(this.parkBrake) ? this.parkBrake : known(this.parkBrakeVsm) ? this.parkBrakeVsm : known(this.parkBrakeCds) ? this.parkBrakeCds : null;
        if (pb === true) return 'park';
        if (this.autoHold === 'hold') return 'hold';
        const d = this.car.data();
        if (pb === null && this.autoHold === null && d.demo && isNum(d.speed) && d.speed < 1) return d.stage === 'P' ? 'park' : 'hold';
        return null;
    }

    /** Which way the indicator points, held while it is on (not blinking): -1 left, 1 right, 0 none or hazards. Always 0
     *  unless config.indicators (the Miku character points that way only then). */
    _turnSide() {
        if (this.config.indicators !== true) return 0;
        const now = Date.now();
        let t = this.turn !== null && now - (this.turnAt || 0) < 5000 ? this.turn : null;
        if (t === null && this.car.data().demo) t = Math.floor(now / 6000) % 4 === 1 ? 'L' : Math.floor(now / 6000) % 4 === 3 ? 'R' : '';
        return t === 'L' ? -1 : t === 'R' ? 1 : 0;
    }

    _turnLit(side) {
        const now = Date.now();
        let t = this.turn !== null && now - (this.turnAt || 0) < 5000 ? this.turn : null;
        if (t === null && this.car.data().demo) t = Math.floor(now / 6000) % 4 === 1 ? 'L' : '';
        return !!t && t.indexOf(side) >= 0 && Math.floor(now / 400) % 2 === 0;
    }

    _cruiseLit() { return this.accOn || (!!this.car.data().demo && Math.floor(Date.now() / 10000) % 3 === 2); }

    /** The odometer in km, null when the car has not sent it; the demo drive's made up. */
    _odometer() { return isNum(this.mileage) ? this.mileage : this.car.data().demo ? 37415 : null; }

    /** Where the red and orange marks start on a rev scale that ends at `max` rpm, as fractions 0..1: red from the
     *  redline, but always covering at least the last 500 rpm (the M40i's scale ends right at its 7000 redline),
     *  orange over the 700 rpm before the red. */
    _redMarks(max) {
        const redFrom = Math.min(this.setting('redline'), max - 500) / max;
        return [redFrom, redFrom - 700 / max];
    }

    /** The scale label nearest the value now: 'speed' (SPEED_SCALE index) or 'rpm' (thousands); null without data. */
    _nearMark(kind) {
        const p = this._nearPos(kind);
        return isNum(p) ? Math.round(p) : null;
    }

    /** Where the value sits on a scale, in label steps (2.5 = halfway between labels 2 and 3); null without one. */
    _nearPos(kind) {
        if (kind === 'rpm') { const r = this._raw('rpm'); return isNum(r) ? r / 1000 : null; }
        const v = this._raw('speed');
        if (!isNum(v)) return null;
        const us = this.setting('units') === 'us';
        return scaleFrac(us ? v * 0.621371 : v, SPEED_SCALE[us ? 'us' : 'metric']) * 8;
    }

    /** The setup rows for the drive mode now, or null before the car has said. */
    _setup() {
        if (!this.driveMode) return null;
        if (this.driveVariant === 'individual') return SETUP.individual;
        return SETUP[this.driveMode === 'sport' && this.driveVariant === 'plus' ? 'sportplus' : this.driveMode];
    }

    /** {{token}} -> display text. */
    /** Collects a big shader's set-once uniforms (shaders.js CFG) into its one u_cfg vec4 array, sent by flush(); any
     *  other uniform goes straight through. cluster-render keeps at most 32 uniform names a layer. */
    _cfgPacker(c, ref, type) {
        const names = shaders.CFG[type] || [], vals = {};
        return {
            u: (name, v, opts) => {
                if (names.indexOf(name) >= 0) vals[name] = v; else c.uniform(ref, name, v, opts);
            },
            flush: () => {
                const flat = [];
                names.forEach((n) => { const v = (vals[n] || []).slice(0, 4); while (v.length < 4) v.push(0); flat.push(...v); });
                c.uniform(ref, 'u_cfg', flat, { type: 'vec4' });
            },
        };
    }

    /** The Regal gear row's lit slot (REGAL_GEARS: P 0, R 1, N 2, D and S 3, M 5 the gear number), -1 for none. */
    _regalGear() {
        const stage = this._token('stage');
        return Object.prototype.hasOwnProperty.call(REGAL_GEARS, stage) ? REGAL_GEARS[stage] : -1;
    }

    _token(tok) {
        const us = this.setting('units') === 'us';
        const fix = (v, n) => (isNum(v) ? v.toFixed(n) : '--');
        if (tok.indexOf('tyreP:') === 0) { const v = this._tyre('p', tok.slice(6)); return isNum(v) ? (us ? fix(v * 14.5038, 0) : fix(v, 1)) : '--'; }
        if (tok.indexOf('tyreT:') === 0) { const v = this._tyre('t', tok.slice(6)); return isNum(v) ? String(Math.round(us ? v * 9 / 5 + 32 : v)) : '--'; }
        switch (tok) {
            case 'u:pressure': return us ? 'psi' : 'bar';
            case 'throttle': { const v = this._throttle(); return isNum(v) ? String(Math.round(v)) : '--'; }
            case 'musicTitle': return this.musicTitle || '';
            // the Regal theme's lamps: their text while lit, else nothing
            case 'lampBrake': { const l = this._brakeLamp(); return l === 'park' ? 'PARK BRAKE' : l === 'hold' ? 'AUTO HOLD' : ''; }
            case 'lampTurnL': return this._turnLit('L') ? 'LT. TURN' : '';
            case 'lampTurnR': return this._turnLit('R') ? 'RT. TURN' : '';
            case 'lampCruise': return this._cruiseLit() ? 'CRUISE' : '';
            case 'odometer': {         // 6 digits, km or mi by the units setting
                const v = this._odometer();
                return isNum(v) ? ('000000' + Math.floor(us ? v * 0.621371 : v)).slice(-6) : '------';
            }
            case 'range3': { const v = this._raw('range'); return isNum(v) ? String(Math.min(999, Math.max(0, Math.round(us ? v * 0.621371 : v)))) : '---'; }   // up to 3 digits, no leading zeros, 999 past it (Regal's pod)
            case 'range4': { const v = this._raw('range'); return isNum(v) ? ('0000' + Math.round(us ? v * 0.621371 : v)).slice(-4) : '----'; }
            case 'u:distUc': return us ? 'MI' : 'KM';
            // the route (while guiding; "--" else): distance left as BMW formats it, its unit, time left h:mm
            case 'navLeft': { const r = this.route; return this.navActive && r && r.leftText ? r.leftText : '--'; }
            case 'u:navLeft': { const r = this.route; return this.navActive && r ? (ROUTE_UNIT[r.leftUnit] || '') : ''; }
            case 'navTime': {
                const r = this.route;
                if (!this.navActive || !r || !isNum(r.timeLeft)) return '--';
                const m = Math.round(r.timeLeft / 60);
                return Math.floor(m / 60) + ':' + ('0' + (m % 60)).slice(-2);
            }
            case 'consumption': { const v = this._consumption(); return isNum(v) ? v.toFixed(1) : '--'; }
            case 'u:cons': return this._consUnit();
            case 'u:consUc': return this._consUnit().toUpperCase();
            case 'ambientN': { const v = this._raw('ambient'); return isNum(v) ? String(Math.round(us ? v * 9 / 5 + 32 : v)) : '--'; }   // no + sign (the seven-segment font has none)
            case 'volt12': { const v = this._volt12(); return isNum(v) ? v.toFixed(1) : '--'; }
            case 'batt12': { const v = this._batt12(); return isNum(v) ? String(Math.round(v)) : '--'; }
            case 'accGap': { const v = this._acc('gap'); return isNum(v) ? String(Math.round(us ? v * 3.28084 : v)) : '--'; }
            case 'u:gap': return us ? 'FT' : 'M';
            case 'accRel': { const v = this._acc('rel'); return isNum(v) ? String(Math.round(us ? v * 0.621371 : v)) : '--'; }   // the HUD fonts have no '+'
            case 'u:rel': return us ? 'MPH' : 'KM/H';
            case 'accSet': { const v = this._acc('set'); return isNum(v) ? String(Math.round(v)) : '--'; }
            case 'speed': { const v = this._raw('speed'); return fix(isNum(v) ? (us ? v * 0.621371 : v) : v, 0); }
            case 'u:speed': return us ? 'MPH' : 'KM/H';
            case 'mph': { const v = this._raw('speed'); return isNum(v) ? String(Math.round(Math.max(0, v) * 0.621371)) : '--'; }   // mph whatever the units (Regal)
            case 'oil': case 'coolant': { const v = this._raw(tok); return fix(isNum(v) ? (us ? v * 9 / 5 + 32 : v) : v, 0); }
            case 'boost': { const v = this._raw('boost'); return us ? fix(isNum(v) ? v * 14.5038 : v, 1) : fix(v, 2); }
            case 'u:boost': return us ? 'PSI' : 'BAR';
            case 'u:temp': return us ? '°F' : '°C';
            // the fuel gauge's marks: the tank (config.tankLitres) full and half, in litres or US gallons, whole numbers
            case 'fuelFull': case 'fuelHalf': {
                const t = (this.config.tankLitres || 65) * (us ? 1 / 3.78541 : 1);
                return String(Math.round(tok === 'fuelFull' ? t : t / 2));
            }
            case 'u:fuel': return us ? 'gal' : 'L';
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
        this.widgets.forEach((x) => { if (x.timer) clearInterval(x.timer); });
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
            (atlasBytes ? ' (' + this.atlases.size + ' atlas' + (this.atlases.size > 1 ? 'es' : '') + ' ' + mib(atlasBytes) + ')' : ''));
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
            else {
                if ((w.type === 'miku' || w.type === 'mikuLie') && !this._sprite(w, this._connOf(w))) return;
                ref = c.effect(Object.assign({ fs: w.type === 'swatch' ? calibration.SWATCH : w.type === 'miku' ? mikuShader(w, this.setting('mikuParts')) : w.type === 'rdash' && w.needleOnly ? shaders.rdashNeedle : shaders[w.type],
                    time: w.type === 'miku' || w.type === 'mikuLie' || undefined }, base));
            }
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
            const pk = this._cfgPacker(c, ref, 'sdash');
            pk.u('u_size', [w.w, w.h]);
            pk.u('u_geo', w.geo);
            pk.u('u_k', w.k);
            pk.u('u_w', [w.band]);
            pk.u('u_inner', [w.inner || w.band + 18]);
            pk.u('u_scale', w.scale || [w.geo[2], w.geo[0]]);
            pk.u('u_ticks', w.ticks);
            const [redFrom, orange] = this._redMarks(w.rpmMax || 8000);
            pk.u('u_redFrom', [redFrom]);
            pk.u('u_orange', [orange]);
            pk.u('u_fuelSeg', w.fuelSeg);
            pk.u('u_oilSeg', w.oilSeg);
            pk.u('u_hole', this._hole(w));
            pk.u('u_holeR', [this._holeRadius(w)]);
            pk.u('u_holeCut', Array.isArray(w.holeCut) && w.holeCut.length === 4 ? w.holeCut : [0, 0, 0, 0]);
            const rel = (r) => (Array.isArray(r) && r.length === 4 ? [r[0] - w.x, r[1] - w.y, r[2], r[3]] : [0, 0, 0, 0]);
            pk.u('u_holeMask', rel(w.holeMask).concat(rel(w.holeOpen)), { type: 'vec4' });
            const hf = Array.isArray(w.holeFade) && w.holeFade.length >= 4 ? w.holeFade : null;
            pk.u('u_holeFade', hf ? [hf[0] - w.x, hf[1] - w.y, hf[2], hf[3]] : [0, 0, 0, 0]);
            pk.u('u_holeFadeK', [hf && isNum(hf[4]) ? hf[4] : 30, hf && isNum(hf[5]) ? hf[5] : 0.85]);
            pk.u('u_strip', w.strip);
            const gg = w.gapGauge && Array.isArray(w.gapGauge.box) ? w.gapGauge.box : null;
            pk.u('u_gapRail', gg ? [gg[0] - w.x, gg[1] - w.y, gg[2], gg[3]] : [0, 0, 0, 0]);
            pk.u('u_gapG', [-1, 0]);
            const vb = Array.isArray(w.vbars) ? w.vbars.slice(0, 2) : [];
            [0, 1].forEach((i) => {
                const b = vb[i] && Array.isArray(vb[i].box) ? vb[i] : null;
                pk.u('u_vbar' + i, b ? [b.box[0] - w.x, b.box[1] - w.y, b.box[2], b.box[3]] : [0, 0, 0, 0]);
                pk.u('u_vbarC' + i, rgb(color(t, (b && b.color) || 'fg')));
            });
            pk.u('u_vbarV', [-1, -1]);
            pk.u('u_stripFill', Array.isArray(w.stripSignals) ? [0, 0, 0] : [-1, 0, 0]);
            pk.u('u_stripRoute', [-1]);
            pk.u('u_topEnd', [w.topEnd]);
            pk.flush();
        } else if (w.type === 'rdash') {
            const pk = this._cfgPacker(c, ref, 'rdash');
            const o4 = (r) => (Array.isArray(r) && r.length === 4 ? [r[0] - w.x, r[1] - w.y, r[2], r[3]] : [0, 0, 0, 0]);
            const sp = w.spd || [0, 0, 0, 0], sv = w.spdVirt || [300, 45];
            pk.u('u_size', [w.w, w.h]);
            ['podL', 'podWin', 'ctr', 'win1', 'win2', 'vfdL', 'vfdR', 'led', 'led2', 'gearBox', 'lampB'].forEach((k) => {
                pk.u('u_' + k, o4(w[k]));
            });
            pk.u('u_spd', [sp[0] - w.x, sp[1] - w.y, sp[2] - w.y, sp[3] - w.y]);
            pk.u('u_spdVirt', [sv[0], sv[1] * Math.PI / 180]);
            pk.u('u_spdK', [w.spdMid || 55, w.spdMax || 85, w.spdStep || 5]);
            const fg = w.fuelG || [0, 0, 0, 0], pg = w.podG || [0, 0, 0, 0], ar = w.arrow || [0, 0, 0], bi = w.batIcon || [-99, -99];
            pk.u('u_fuelG', [fg[0] - w.x, fg[1] - w.y, fg[2], fg[3]]);
            pk.u('u_podG', [pg[0] - w.x, pg[1] - w.y, pg[2], pg[3]]);
            pk.u('u_arrow', [ar[0] - w.x, ar[1] - w.y, ar[2]]);
            pk.u('u_batIcon', [bi[0] - w.x, bi[1] - w.y]);
            if (w.needleOnly) pk.u('u_speedV', [0]);   // the needle's own layer: only the speed changes
            else { pk.u('u_gearV', [w.gearPitch || 0, -1]); pk.u('u_lamps', [0, 0, 0, 0]); }
            pk.flush();
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
            c.uniform(ref, 'u_hotSeg', [-1]);
            c.uniform(ref, 'u_hotC', rgba(color(t, w.hotColor || 'hot')));
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
        } else if (w.type === 'miku') {
            // the bake's "anchor" (frame px, between her feet) goes on the widget's "feet" point
            const sp = this._sprite(w, x.ci), j = sp.info, ft = Array.isArray(w.feet) && w.feet.length === 2 ? w.feet : [480, 377];
            const fr = (k) => (j.frames && j.frames[k]) || j.frames.idle;
            const rect = (o) => (o && Array.isArray(o.rect) ? o.rect : [0, 0, 0, 0]);
            c.bind(ref, 'u_atlas', sp.ref);
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_atlasSize', sp.size);
            c.uniform(ref, 'u_frame', j.frame);
            c.uniform(ref, 'u_origin', [ft[0] - w.x - j.anchor[0], ft[1] - w.y - j.anchor[1]]);
            // the fixed sprite values go up as three vec4 arrays (u_spr: the eye frames, the tails, the crop and the
            // tables' counts; u_arm), which shaders.js miku names back with #define; the per-frame tables (lean,
            // glance and doze frames, head and hip shifts) are pixel rows under the atlas (_sprite, mikuData). Few
            // uniforms: the cluster's GPU restarted on the 0.1.9 .. 0.1.12 shader's 55 uniform vectors (or its size)
            const spr = fr('idle').concat(fr('half'), fr('shut'), fr('talk'));
            const am = Array.isArray(j.arms) ? j.arms.slice(0, 2) : [], v3 = (o) => (Array.isArray(o) ? [o[0] || 0, o[1] || 0, o[2] || 0, 0] : [0, 0, 0, 0]);
            const armF = [];
            [0, 1].forEach((i) => {
                const a = am[i];
                armF.push(...(a ? a.rect : [0, 0, 0, 0]), ...(a ? [a.at[0], a.at[1], a.shoulder[0], a.shoulder[1]] : [0, 0, 0, 0]),
                    ...v3(a && a.left), ...v3(a && a.right));
            });
            c.uniform(ref, 'u_arm', armF, { type: 'vec4' });
            c.uniform(ref, 'u_armSide', [am[0] ? am[0].side : -1, am[1] ? am[1].side : 1, (isNum(w.point) ? w.point : 60) * Math.PI / 180,
                // the arms balance a sideways lean only: leaning toward or away from you they just ride along
                j.leanAxis === 'fb' ? 0 : (isNum(w.balance) ? w.balance : 50) * Math.PI / 180]);
            x.lookN = sp.counts.look; x.dozeN = sp.counts.doze;
            c.uniform(ref, 'u_idle', [0, 0, 0, 0]);
            c.uniform(ref, 'u_hip', [j.hipY, isNum(j.headY) ? j.headY : 0, j.breathe === false ? 0 : 1, 0]);
            // her lean on its own 60 Hz timer, not the 20 Hz tick: the shader draws at the display's rate, and a lean that
            // moved only every third frame would step. A message goes up only when the lean or speed changes a step
            x.timer = setInterval(() => this._guard('widget ' + w.id, () => this._update(x, Date.now(), false)), MIKU_MS);
            const tl = j.tails || null;
            // u_spr[4]: the rect the face, glance and doze frames are crops of (none: an older bake's whole frames)
            const cr = Array.isArray(j.crop) && j.crop.length === 4 ? j.crop : [0, 0, 0, 0];
            c.uniform(ref, 'u_spr', spr.concat(rect(tl), tl ? [tl.at[0], tl.at[1], tl.rootY || 0, tl.length || tl.rect[3]] : [0, 0, 0, 1], cr,
                [sp.counts.lean, sp.counts.look, sp.counts.doze, sp.dataY]), { type: 'vec4' });
        } else if (w.type === 'mikuLie') {
            // her frame centred in the widget's box, lying on its bottom edge (less "floor" px)
            const sp = this._sprite(w, x.ci), j = sp.info, fr = j.frame;
            c.bind(ref, 'u_atlas', sp.ref);
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_atlasSize', sp.size);
            c.uniform(ref, 'u_spr', j.frames.idle.concat(j.frames.half, j.frames.shut, fr, j.crop), { type: 'vec4' });
            const br = Array.isArray(j.breathe) ? j.breathe : [0, 0, fr[1] / 2];
            c.uniform(ref, 'u_breath', [br[0], br[1], br[2], 0]);
            x.origin = [Math.round((w.w - fr[0]) / 2), w.h - fr[1] - (isNum(w.floor) ? w.floor : 0)];
            x.lookN = 0; x.dozeN = 0;   // no glances; the HUD Miku's doze loop
            c.uniform(ref, 'u_lie', x.origin.concat([0, 1]));
            x.timer = setInterval(() => this._guard('widget ' + w.id, () => this._update(x, Date.now(), false)), MIKU_MS);
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
        this.widgets.forEach((x) => { if (!x.timer) this._guard('widget ' + x.w.id, () => this._update(x, now, false)); });
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
            if (w.near && isNum(w.nearFade)) {
                // fade in as the value comes near (iDrive 8): full "nearColor" at the label, its own colour "nearFade"
                // label steps away, in 8 steps so a label repaints only when its step changes
                const pos = this._nearPos(w.near[0]);
                const f = isNum(pos) ? Math.round(Math.max(0, 1 - Math.abs(pos - w.near[1]) / w.nearFade) * 8) / 8 : 0;
                if (f > 0) {
                    const a = color(this.theme, role), b = color(this.theme, w.nearColor || 'fg');
                    role = [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * f));
                }
            } else if (w.near && this._nearMark(w.near[0]) === w.near[1]) role = w.nearColor || 'fg';
            // "litGear": the Regal gear row's slot (P 0, R 1, N 2, D 3, the gear number 5): while the lit gear box sits
            // behind it, the text turns "litColor" (fg: white on the box is 5.0:1, WCAG AA; the VFD orange was 1.9:1)
            if (isNum(w.litGear) && this._regalGear() === w.litGear) role = w.litColor || 'fg';
            if (w.hotWhen === 'closing') { if (this._closing()) role = 'hot'; }
            else if (w.hotWhen || w.coldWhen) {
                const sp = this._shift();
                if (w.coldWhen && sp[w.coldWhen]) role = VERDICT.COLD;
                if (w.hotWhen && sp[w.hotWhen]) role = 'hot';
            }
            // "slide": the text rides up its box with a value (the car-ahead gauge's label), blank without one
            let offY = 0, text = s;
            if (w.slide) {
                const v = w.slide.signal === 'accGap' ? this._acc('gap') : this._raw(w.slide.signal);
                if (!isNum(v)) text = '';
                else {
                    const lo = w.slide.min || 0, f = Math.min(1, Math.max(0, (v - lo) / ((w.slide.max || 150) - lo)));
                    const y = w.slide.yBottom - f * (w.slide.yBottom - w.slide.yTop);
                    offY = Math.round(y - w.y - textRaster.loadFont(w.font).metrics.cellHeight / 2);
                }
            }
            const key = text + '|' + role + '|' + offY;
            if (!force && key === x.last) return;
            x.last = key; x.lastPaint = now;
            let buf;
            if (w.font === '@sys') {
                // the car's own font, any script ("size" px, default 80 % of the box)
                const f = this._sysFont();
                const m = f && text ? f.mask(w.w, w.h, text, { size: w.size || Math.round(w.h * 0.8), align: w.align }) : Buffer.alloc(w.w * w.h);
                buf = textRaster.tint(m, w.w, w.h, { color: color(this.theme, role) });
            } else buf = textRaster.drawText(w.w, w.h, text, {
                font: w.font, color: color(this.theme, role), align: w.align, spacing: w.spacing, offsetY: offY,
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
                // oil: 50..150 C with 110 (the B58's running temperature) at the bar's middle, each half linear
                q(isNum(oil) ? (oil <= 110 ? 0.5 * (oil - 50) / 60 : 0.5 + 0.5 * (oil - 110) / 40) : 0),
            ];
            // the strip's two bars: each signal over its "stripMax", in 50 steps
            const ss = Array.isArray(w.stripSignals) ? w.stripSignals : null, sm = Array.isArray(w.stripMax) ? w.stripMax : [100, 10];
            const strip = ss ? [0, 1].map((i) => { const v = ss[i] ? this._raw(ss[i]) : null; return isNum(v) ? Math.round(Math.min(1, Math.max(0, v / (sm[i] || 1))) * 50) / 50 : 0; }) : null;
            const hot = !!ss && w.stripHotWhen === 'kickdown' && this._kickdown();
            // the car-ahead gauge: the gap over its "max" m, in 300 steps; red while closing fast
            const gm = w.gapGauge ? this._acc('gap') : null;
            const gv = isNum(gm) ? Math.round(Math.min(1, Math.max(0, gm / (w.gapGauge.max || 150))) * 300) / 300 : -1;
            const gHot = gv >= 0 && this._closing();
            // boost and battery boxes: each signal over its "range" [lo, hi], in 100 steps
            const vbv = Array.isArray(w.vbars) && w.vbars.length ? [0, 1].map((i) => {
                const b = w.vbars[i], v = b && b.signal ? this._raw(b.signal) : null, r = (b && b.range) || [0, 1];
                return isNum(v) ? Math.round(Math.min(1, Math.max(0, (v - r[0]) / (r[1] - r[0]))) * 100) / 100 : -1;
            }) : null;
            // while guiding, "routeStrip" turns the strip into the route's progress (filled from the right), in 400 steps
            const rp = w.routeStrip ? this._routeProgress() : null;
            const route = isNum(rp) ? Math.round(rp * 400) / 400 : -1;
            const key = vals.join('|') + (strip ? '|' + strip.join('|') + (hot ? 'h' : '') : '') + (w.gapGauge ? '|' + gv + (gHot ? 'c' : '') : '') + (vbv ? '|' + vbv.join('|') : '') + '|' + route;
            if (!force && key === x.last) return;
            x.last = key;
            if (w.gapGauge) x.c.uniform(x.ref, 'u_gapG', [gv, gHot ? 1 : 0]);
            if (vbv) x.c.uniform(x.ref, 'u_vbarV', vbv);
            if (strip) x.c.uniform(x.ref, 'u_stripFill', [strip[0], strip[1], hot ? 1 : 0]);
            x.c.uniform(x.ref, 'u_stripRoute', [route]);
            x.c.uniform(x.ref, 'u_speed', [vals[0]]);
            x.c.uniform(x.ref, 'u_rpm', [vals[1]]);
            x.c.uniform(x.ref, 'u_fuel', [vals[2]]);
            x.c.uniform(x.ref, 'u_oil', [vals[3]]);
        } else if (w.type === 'rdash') {
            const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 500) / 500;
            const sp = this._raw('speed'), rpm = this._raw('rpm'), fuel = this._raw('fuel'), max = w.rpmMax || 8000;
            // the pods' gauges: each "podSignals" entry's signal over its range, bottom to top
            const pods = [0, 1].map((i) => {
                const g = (w.podSignals || [])[i], v = g && g.signal ? this._raw(g.signal) : null, r = (g && g.range) || [0, 1];
                if (!isNum(v)) return 0;
                // "mid": the value at the scale's middle mark (each half linear), e.g. the coolant's 110 C
                const m = g && isNum(g.mid) ? g.mid : null;
                if (m !== null) return q(v <= m ? 0.5 * (v - r[0]) / (m - r[0]) : 0.5 + 0.5 * (v - m) / (r[1] - m));
                return q((v - r[0]) / (r[1] - r[0]));
            });
            const n = w.ledN || 16;
            const led = isNum(rpm) ? Math.floor(Math.max(0, rpm) / max * n + 0.5) / n : 0;
            const shiftAt = Math.floor(this._shift().rpm / max * n) / n;
            // the boost bar: "led2Signal" over "led2Range" [lo, hi] in "led2N" segments
            const n2 = w.led2N || 15, r2 = w.led2Range || [0, 1.5], b2 = this._raw(w.led2Signal || 'boost');
            const led2 = isNum(b2) ? Math.floor(Math.min(1, Math.max(0, (b2 - r2[0]) / (r2[1] - r2[0]))) * n2 + 0.5) / n2 : 0;
            const gi = this._regalGear();
            const bl = this._brakeLamp(), lamps = [bl === 'park' ? 1 : bl === 'hold' ? 2 : 0, this._turnLit('L') ? 1 : 0, this._turnLit('R') ? 1 : 0, this._cruiseLit() ? 1 : 0];
            // speed on the 0..spdMax mph scale with spdMid at its middle, each half linear
            const mid = w.spdMid || 55, top = w.spdMax || 85, mph = isNum(sp) ? Math.max(0, sp * 0.621371) : 0;
            // below the first mark ("spdStep", 5 mph) the needle drops to its rest under the row ("spdRest" deg past the 0, 12)
            const st = w.spdStep || 5, half = (w.spdVirt || [300, 45])[1], rest = -(isNum(w.spdRest) ? w.spdRest : 12) / (2 * half);
            const f5 = 0.5 * st / mid;
            let f = mph <= mid ? 0.5 * mph / mid : 0.5 + 0.5 * (mph - mid) / (top - mid);
            if (mph < st) f = rest + (f5 - rest) * mph / st;
            const vals = [Math.round(Math.min(1, Math.max(-0.5, f)) * 500) / 500, q(isNum(fuel) ? fuel : 0)];
            if (w.needleOnly) {   // the speed needle's own layer (over the text): only its speed
                if (!force && vals[0] === x.last) return;
                x.last = vals[0];
                x.c.uniform(x.ref, 'u_speedV', [vals[0]]);
                return;
            }
            const key = vals.join('|') + '|' + pods.join('|') + '|' + led + '|' + shiftAt + '|' + led2 + '|' + gi + '|' + lamps.join('');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_speedV', [vals[0]]);
            x.c.uniform(x.ref, 'u_fuelV', [vals[1]]);
            x.c.uniform(x.ref, 'u_podV', pods);
            x.c.uniform(x.ref, 'u_ledV', [n, led, shiftAt]);
            x.c.uniform(x.ref, 'u_led2V', [n2, led2]);
            x.c.uniform(x.ref, 'u_gearV', [w.gearPitch || 0, gi]);
            x.c.uniform(x.ref, 'u_lamps', lamps);
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
            let v = this._raw(w.signal);
            if (isNum(v) && Array.isArray(w.range) && w.range.length === 2) v = (v - w.range[0]) / (w.range[1] - w.range[0]) * w.max;
            const lit = isNum(v) ? Math.max(0, Math.min(w.max, Math.round(v))) : 0;
            const hot = w.hotWhen === 'kickdown' && this._kickdown() && lit === w.max;   // the last segment in "hotColor"
            const key = lit + (hot ? 'h' : '');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_lit', [lit]);
            x.c.uniform(x.ref, 'u_hotSeg', [hot ? w.max - 1 : -1]);
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
        } else if (w.type === 'miku') {
            // lean: the longitudinal g, -0.4 g .. +0.4 g to -1 .. 1, eased over MIKU_LEAN_TAU_MS; speed 0..130 km/h to
            // 0..1, eased over MIKU_TAU_MS; both sent in steps of 0.002 (a small uniform message, at most one per MIKU_MS, and only while she moves)
            const d = this.car.data(), dt = x.at ? Math.min(500, now - x.at) : 0;
            x.at = now;
            // standing on a bus: the lean eases toward the g (as Unreal's FInterpTo, but 1 - exp(-dt / tau), the same at
            // any update rate), so she leans into a pull and straightens when it ends, without swaying back past upright;
            // the ease also smooths the car's steppy, noisy g
            const g = isNum(d.gLong) ? Math.max(-0.4, Math.min(0.4, d.gLong)) / 0.4 : 0;
            x.lean = isNum(x.lean) ? x.lean + (g - x.lean) * (1 - Math.exp(-dt / MIKU_LEAN_TAU_MS)) : g;
            // pointing: toward the indicator ('L' -1, 'R' 1, hazards or none 0), on a quicker spring (about 1.3 Hz, no
            // overshoot) so the arm rises and falls smoothly
            const tp = this._turnSide(), dtp = dt / 1000;
            if (!isNum(x.point)) { x.point = tp; x.pointV = 0; }
            for (let left = dtp; left > 0; left -= 0.01) {
                const h = Math.min(0.01, left);
                x.pointV += (MIKU_POINT_K * (tp - x.point) - MIKU_POINT_C * x.pointV) * h;
                x.point = Math.max(-1, Math.min(1, x.point + x.pointV * h));
            }
            const v = this._raw('speed'), sv = isNum(v) ? Math.min(1, Math.max(0, v / 130)) : 0, step = (f) => Math.round(f * 500) / 500;
            this._mikuIdle(x, now, dt, d.gLong, v);
            x.spd = isNum(x.spd) ? x.spd + (sv - x.spd) * (1 - Math.exp(-dt / MIKU_TAU_MS)) : sv;
            // a soft limit: past a full lean the spring's swing eases into it instead of stopping dead
            const u = [step(Math.tanh(x.lean * 1.15)), step(x.spd), step(x.point), this.themeName === 'night' ? 0.8 : 1];
            const ui = [step(x.look), step(x.doze), 0, 0];
            const key = u.join('|'), keyI = ui.join('|');
            if (force || keyI !== x.lastI) { x.lastI = keyI; x.c.uniform(x.ref, 'u_idle', ui); }
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_drive', u);
        } else if (w.type === 'mikuLie') {
            // lying still: only the doze loop (stopped 15 s: 5 s asleep, 5 s awake, ...); the blink and breath run in
            // the shader on the renderer's clock
            const d = this.car.data(), dt = x.at ? Math.min(500, now - x.at) : 0;
            x.at = now;
            this._mikuIdle(x, now, dt, d.gLong, this._raw('speed'));
            const u = x.origin.concat([Math.round(x.doze * 500) / 500, this.themeName === 'night' ? 0.8 : 1]), key = u.join('|');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_lie', u);
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

    /**
     * The Miku character while the car idles (|longitudinal g| under MIKU_IDLE_G): from MIKU_GLANCE_AFTER_MS on she
     * glances left or right now and then (x.look -1 .. 1 on a critically damped spring: turn, hold 1 to 3 s, back,
     * a pause of 2 to 6 s), and once the car has also stood still for MIKU_DOZE_AFTER_MS she loops: dozes for
     * MIKU_DOZE_PHASE_MS (x.doze 0 .. 1: eyes shut, then the head drooping), wakes for as long (head up, eyes open,
     * glancing), dozes again, and so on; x.doze rides a critically damped spring so neither the droop nor the waking
     * snaps. Any g past the deadzone or
     * pulling away ends both smoothly; the lean itself is never gated.
     */
    _mikuIdle(x, now, dt, gLong, speed) {
        const idle = !isNum(gLong) || Math.abs(gLong) < MIKU_IDLE_G, still = isNum(speed) && speed < 1;
        x.idleMs = idle ? (x.idleMs || 0) + dt : 0;
        x.stillMs = idle && still ? (x.stillMs || 0) + dt : 0;
        if (!isNum(x.look)) { x.look = 0; x.lookV = 0; x.doze = 0; x.dozeV = 0; x.lookT = 0; x.lookUntil = 0; }
        // the doze loop: doze, wake, doze, ... from MIKU_DOZE_AFTER_MS on, MIKU_DOZE_PHASE_MS each
        const looping = x.dozeN !== undefined && x.stillMs >= MIKU_DOZE_AFTER_MS;
        const dozing = looping && Math.floor((x.stillMs - MIKU_DOZE_AFTER_MS) / MIKU_DOZE_PHASE_MS) % 2 === 0;
        if (dozing) x.wokeUp = true;
        const rnd = (a, b) => a + Math.random() * (b - a);
        // the glance's target: none unless idle (and not dozing); otherwise turn, hold, return, pause, at random
        if (!idle || dozing || x.lookN < 3) { x.lookT = 0; x.lookUntil = 0; }
        else if (x.idleMs >= MIKU_GLANCE_AFTER_MS) {
            // the first glance: straight away when the car goes idle, soon after she wakes in the doze loop
            if (!x.lookUntil) { x.lookT = 0; x.lookUntil = now + (x.idleMs - dt < MIKU_GLANCE_AFTER_MS ? 0 : x.wokeUp ? rnd(800, 1800) : rnd(2000, 6000)); x.wokeUp = false; }
            if (now >= x.lookUntil) {
                if (x.lookT) { x.lookT = 0; x.lookUntil = now + rnd(2000, 6000); }
                else { x.lookT = (Math.random() < 0.5 ? -1 : 1) * rnd(0.45, 1); x.lookUntil = now + rnd(1000, 3000) + 500; }
            }
        }
        for (let left = dt / 1000; left > 0; left -= 0.01) {
            const h = Math.min(0.01, left);
            x.lookV += (MIKU_LOOK_K * (x.lookT - x.look) - MIKU_LOOK_C * x.lookV) * h;
            x.look = Math.max(-1, Math.min(1, x.look + x.lookV * h));
        }
        if (!x.lookT && Math.abs(x.look) < 0.002 && Math.abs(x.lookV) < 0.01) { x.look = 0; x.lookV = 0; }
        // the droop and the waking on a critically damped spring: each starts gently and settles without a bounce
        const target = dozing ? 1 : 0, w = dozing ? MIKU_DROOP_W : looping ? MIKU_RISE_W : MIKU_WAKE_W;
        for (let left = dt / 1000; left > 0; left -= 0.01) {
            const h = Math.min(0.01, left);
            x.dozeV += (w * w * (target - x.doze) - 2 * w * x.dozeV) * h;
            x.doze = Math.max(0, Math.min(1, x.doze + x.dozeV * h));
        }
        if (!target && x.doze < 0.002 && Math.abs(x.dozeV) < 0.01) { x.doze = 0; x.dozeV = 0; }
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
