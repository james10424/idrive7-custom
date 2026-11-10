# Architecture

Both apps (Custom Cluster, Custom HUD) are built from `apps/<id>/` plus the shared engine in `shared/`, and run on
the car's Node 8 (CommonJS, nothing newer than Node 8 syntax). The engine draws through cluster-render: effect
layers (GLSL shaders), image layers (pixels, packed into sheets) and assets (glyph atlases, Miku's frames).

## Layout of `shared/`

```
shared/
  hud.js            the entry the apps require ("./hud"): re-exports the engine
  engine/           the generic core: no widget type is named here
    app.js          HudApp: settings, start / stop, connections, rebuild, create / update / tick through the registry
    plan.js         layer planning: sheets, packing, blits, dirty rects
    status.js       the status row and its detail line
    modes.js        which layout and HUD mode (nav, cruise), themes
    assets.js       glyph atlases (R8 assets) shared by effect widgets
    cfg.js          packCfg / the u_cfg packer for big shaders (cluster-render keeps 32 uniform names a layer)
    util.js         small helpers (isNum, rgb, rgba, mib, pad2)
  car/              car data and the values derived from it, split by concern
    signals.js      the kit Car plus the app's extra SOME/IP signals, the engine unit reads (UDS)
    values.js       raw values, smoothing, boost, pedals, brake, tyres, odometer, shift point, scales
    lamps.js        brake / turn / cruise lamps, the gear row slot
    route.js        BMW's route guidance and media
    assist.js       driver assistance and the car ahead
    tokens.js       {{token}} text for text widgets
    consts.js       the car's enums and tables
  widgets/
    index.js        the registry: type name -> module
    <type>/index.js one folder per widget type (related types may share one)
  layouts.js        layout files and their check (required fields come from the registry)
  hud_text.js, hud_themes.js, icons.js, shift_score.js, sun.js, ...   shared libraries
```

The app build (`kit/tools/build.py`) copies the files and folders listed in each `app.json` `"shared"`; a folder entry
ends in `/` (`"engine/"`, `"car/"`, `"widgets/"`) and ships whole, so relative requires keep working in `dist/`.

## A widget module

`shared/widgets/<type>/index.js` exports:

| field | what |
| --- | --- |
| `type` | its name in layout files |
| `fields` | fields a layout must give it (`layouts.js` refuses a widget without them) |
| `docs` | what it draws and the fields it reads |
| `image` | `true`: drawn as pixels (an image layer, packed into a sheet unless `"own": true`); else an effect layer |
| `shader(hud, w, ci)` | an effect type's GLSL, or `null` when it cannot draw now (it logs why) |
| `time` | `true`: cluster-render animates the effect on its own clock |
| `cfg` | uniforms packed into `u_cfg` (big shaders only) |
| `shaders` | `{ name: GLSL }` of every shader it can send, for `tools/shader_budget.js` |
| `create(hud, w, x)` | sets up its layer once made (fixed uniforms, the first paint) |
| `update(hud, x, now, force)` | sends what changed (`force`: everything) |

`hud` is the engine (HudApp): a module reads car values (`hud._raw`, `hud._shift`, ...), settings (`hud.setting`),
the theme (`hud.theme`) and paints through `hud._blit` / `hud._blitDiff`. Everything a type owns (its GLSL, its
helpers, its constants and state) lives in its folder; a type is removed by deleting its folder and its registry line.

## Checks

- `node tools/shader_budget.js`: every widget type's shaders against what the KOMBI is known to take.
- The bench (`bench/README.md`) builds both apps into `dist/` and draws them as the car would.
