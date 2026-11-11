# Developing

## Repo layout

```
apps/<id>/        one folder per app: app.json, main.js (entry), NOTICE, README
                  subfolders (hud/: fonts, layouts) are packed into <folder>.pack by the build
shared/           the cluster-render drawing engine both apps use: engine/ (the generic core), car/ (the
                  car's data), widgets/ (one module per widget type) and shared libraries; an app lists
                  the files and folders it needs in app.json "shared" and the build copies them in.
                  See docs/ARCHITECTURE.md
kit/              cauliflowermossgrape's MGU App Kit (MIT, kit/LICENSE): runtime/ ships inside each app,
                  tools/ builds it. One change from upstream: kit/tools/build.py copies the app.json
                  "shared" files and folders (marked "bimmer-lab addition")
bench/            Mac test bench (fake cluster-render + the kit's stub head unit), see bench/README.md
tools/            bake_fonts.py re-bakes each app's fonts from tools/fonts-src (needs Pillow)
scripts/          deploy.sh pushes layout files to the car over SSH
docs/images/      the screenshots and GIFs in the READMEs, taken from the bench
mgu-repo.json     tells the Store how to build the apps
```

## Build

`python3 kit/tools/build.py <id>` builds one app into `dist/`. It needs an `oap-sdk/` folder. On the car the Store makes the real one from a BMW app. On the Mac the bench writes a stub, which is gitignored and must never ship.

## Test on the Mac

```sh
node bench/server.js                   # Custom HUD, then open http://localhost:8078
node bench/server.js custom_cluster    # Custom Cluster
node bench/server.js custom_cluster custom_hud   # both at once, as on the car
```

The page has buttons for the drive mode (COMFORT, SPORT, SPORT+, ECO PRO), fed in as the car's FES signal. It builds the app with the kit and runs the build in the kit's stub head unit on Node 8.16.2 (the car's version), against a fake cluster-render. The page shows the HUD or the cluster with the app's real pixels and shaders, the center-screen status and settings, and signal sliders. Details in `bench/README.md`.

## Layouts

Each app's layouts are `apps/<id>/hud/layouts/<name>.json` (`schemaVersion: 2`). Each widget type is a module in `shared/widgets/<type>/` whose `docs` lists its fields; text tokens are in the header of `shared/car/tokens.js`, and the options every widget takes (`toggle`, `themes`, `conn`, `own`, `in`) in the header of `shared/engine/app.js`. `shared/layouts.js` checks every layout and refuses a bad one with the reason, which also shows on the app's status row.

- **HUD (800x480):** `text`, `scale`, `stripe`, `shiftbar`, `arc`, `revbar`, `lights`, `badge`. Colours are theme roles (`fg`, `dim`, `arc`), so a layout works in every theme.
- **`atext` (both):** text drawn by the GPU: an effect layer that reads a glyph atlas of the font, uploaded once per connection as an R8 asset (one byte a pixel, not a layer, shared by every `atext` on that font). A value change is one uniform message of glyph codes, no pixels. Equal cells across the widget (`cells`, up to 32; the glyphs keep their shape at `w` = cells x the font's widest advance + 2 and `h` = its cell height, which the log states), `align` left, right or center, only the characters the font has. The calibration grids carry one as a probe (0.7.3 / 0.5.3), and the car drew it on both the cluster and the HUD (Nov 6 2026), so the plan is to move every readout onto this path (see `research/findings.md`, "Cost levers").
- **Cluster (1920x720):** the same types, plus `fill` (a solid colour with a see-through `hole` cut while a setting is on) and `box` (a framed readout with a header strip). A cluster layout names its own `"theme"`.
- **Sport theme:** `sdash` draws the whole theme (brackets, fills, the map cut-out or a black middle, fuel and oil bars, bottom strip) in one shader. Text `near: ["speed" | "rpm", i]` lights up the scale label nearest the value.
- **Regal theme:** `rdash` draws the pods, frames, needles, LED rev bar, gear box and lamps in one shader; the numbers and VFD readouts are text widgets (the seven-segment fonts are drawn by `tools/bake_fonts.py`, no font file). The layout is written by `tools/gen_regal.py`; edit that, not the JSON.
- **Older pieces:** the engine still has `boxes` (the removed GT3 theme, Custom Cluster 0.1.23) and `icon` (line icons in `shared/widgets/icon/icons.js`).
- **Layout generators:** the Sport layout is written by `design/gen_sport.py` (next to the repo); edit the generator, not the JSON.
- **Calibration:** `grid` (lines every `step` px, brighter every `major` steps) and `gridlabels` (x/y labels every `step` px). Each app ships a `grid.json` layout.
- **Off:** the layout name `off` draws nothing and releases the screen. While route guidance is on, the cluster's `navLayout` setting picks the layout (and opens the map window). In apps with `byMode` on, the `inComfort` / `inSport` / `inEco` settings pick the layout from the car's drive mode (FES `statusFESVehicleDynamicSwitchHMI`).
- **Effect shaders:** cluster-render's `v_uv` has (0,0) at the top-left. The bench draws the same way.
- **Layer packing:** cluster-render allows 64 layers per client connection and 96 across all clients since 0.4.2 (`CompositorLimits` in its source; before that 8 and 32, which the car showed on Nov 5 2026). The engine still packs every image widget (a module with `image: true`: text, scale, icon, ...) into a few image "sheets" (one layer each, grouped by class and z, split where widgets overlap or a sheet would grow past a quarter of the target) and keeps effects one layer each; sheets start at a quarter of the target (cheaper rebuilds) and grow only if a connection would need more than 64 layers, which it warns about in the log. Many small effect layers are now fine and safer than one big shader (see Shader budget below). Put effect widgets first in a layout's file order and text after, so the text lands in as few sheets as possible. `"own": true` keeps an image widget on its own layer (the calibration probes). The limit is per connection, so `"conn": 1..3` on a widget puts its layer (or its sheet) on a second, third or fourth connection to cluster-render, each with its own 64 layers (96 service-wide, shared by every app on the car); with 64 a connection a layout rarely needs it. The service also has 16 MiB of pixel memory for every app's images together and counts each image twice, so an image layer costs w*h*8 bytes and the layout is refused past that ("the service's pixel memory is full"). The status row shows the layer count, the connections and the pixel memory; the rebuild log line says how many sheets, how many bytes the whole-sheet writes cost and the pixel memory. Text and badge widgets send only the rectangle around the pixels that changed since their last paint.
- **Shader budget:** the cluster's GPU (the KOMBI) restarts about 2 s after a too-big effect shader shows. Custom HUD 0.1.15's Miku did that with 38 texture reads (counted with every function inlined into `main`); 0.1.16's 32 hold, and so does Sport's 7835-token shader, which reads no textures. [tools/shader_budget.js](../tools/shader_budget.js) measures each shader against those marks: the bench refuses an effect layer at 38 reads or more and warns past 32 reads or past Sport's size; `node tools/shader_budget.js` checks every shader of every widget type (each module's `shaders`, shared/widgets) and exits 1 on a crash-level one. Run it before shipping a shader change. Details in [tools/live2d_bake/README.md](../tools/live2d_bake/README.md#what-the-cluster-can-take).
- **Swapping an RGBA asset:** an atlas can be replaced while the app runs. The engine keys each uploaded atlas by its connection, folder and file time (`sprite` in `shared/widgets/miku/sprite.js`); when the key changes it drops the old asset first (`drop`), then uploads the new one, so only one is ever in the pixel memory and no app restart is needed. Confirmed on the car (Nov 9 2026) with Custom HUD 0.1.18's Miku lean setting: switching Sideways and Forward and back rebuilt the layout and swapped her 1024x564 atlas (4.4 MiB) for the other bake, and the new frames showed. The same path takes a new bake pushed with `deploy.sh --miku` on the next layout build. Use it for any setting that picks between big images: one asset at a time, never both.
- **Any widget:** `toggle: "setting"` shows it only while that setting is on, and `"!setting"` only while it's off. `"setting=value"` shows it only while a choice setting has that value. `themes: [...]` limits it to certain themes.

**Visibility check.** Not every pixel of a target reaches the driver's eye: on the cluster the hood hides the top corners (down to y 273 at the left edge and y 240 at the right, nothing at the center), the dash camera hides x 760-1200 down to y 135 (car photo, Nov 8 2026), BMW paints a solid black gear box over us at x 1406-1597 y 342-419 and its seat-belt light at x 587-626 y 663-700; on the HUD only x 120, y 100, 485x278 of the 800x480 target shows through the windshield (it moves with eye position). These numbers were measured from car photos on Nov 5 2026 (`design/photos/calibration-2026-11-05.json`, pictures next to it) and live in `shared/visible.js`. `layouts.js` runs its `check()` after validating a layout and logs one warning per widget that is under the hood, under the box or light, or outside the HUD window; it never refuses a layout for this. The bench draws the same geometry as its "car view" and flags the layers (see `bench/README.md`).

To try an edited layout on the car without reinstalling:

```sh
./scripts/deploy.sh root@<car-ip-or-hostname> my-layout.json                    # Custom HUD
APP=custom_cluster ./scripts/deploy.sh root@<car-ip-or-hostname> regal.json      # Custom Cluster
```

The file lands in the app's `data/layouts/` on the car, overrides the built-in layout of the same name, and the running app reloads it by itself.

## Adding a widget type

Make `shared/widgets/<type>/index.js` (copy a small one, e.g. `segbar`) exporting `type`, `fields`, `docs`, `image` or `shader` (and `shaders` for the budget), `create(hud, widget, state)` and `update(hud, state, now, force)`; keep its GLSL in `shader.js` and its helpers next to it. Add one line to `shared/widgets/index.js`. Nothing in `shared/engine/` or `shared/layouts.js` changes. Removing a type is the reverse: its folder and its registry line. `docs/ARCHITECTURE.md` has the details.

## Fonts

Barlow, pre-baked into alpha atlases by `tools/bake_fonts.py` (the car never rasterizes fonts). Re-bake after changing sizes or characters:

```sh
uv run --no-project --with pillow python tools/bake_fonts.py [app_id]
```

## Adding an app

1. Make `apps/<id>/` with an `app.json` (id, title, version, signals, screens, settings) and a `main.js` that calls `mgu.run`. An app that draws through cluster-render lists the engine files and folders in `"shared"` (as the two apps do: `"engine/"`, `"car/"`, `"widgets/"` and the libraries) and sets `config.target` (`hud` or `panel`).
2. Build it once by hand to check it.
3. The Store picks it up from `apps/*` on its next refresh.

## Crash safety

The kit turns an uncaught exception into an app exit, and on the car a second unexpected exit uninstalls the app. Every timer, event and widget in the engine runs inside a guard that logs the error and carries on.
