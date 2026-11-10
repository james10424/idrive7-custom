# Architecture

Both apps (Custom Cluster, Custom HUD) are built from `apps/<id>/` plus the shared engine in `shared/`, and run on
the car's Node 8 (CommonJS, nothing newer than Node 8 syntax). The engine draws through cluster-render: effect
layers (GLSL shaders), image layers (pixels, packed into sheets) and assets (glyph atlases, Miku's frames).

## Layout of `shared/`

```
shared/
  hud.js            the entry the apps require ("./hud"): re-exports engine/app.js
  engine/           the generic core: no widget type is named here
    app.js          HudApp: settings, start / stop, connections, rebuild, create / update / tick through the registry;
                    its header documents what every widget takes (toggle, themes, in, conn, own) and the limits
    plan.js         layer planning: sheets, packing, blits, dirty rects, connections
    status.js       the status row and its detail line
    modes.js        which layout shows, the HUD mode (cruise, nav), the theme, "toggle" and the map "hole"
    assets.js       glyph atlases (R8 assets), the car's own font, the u_cfg packer
    cfg.js          packCfg: moves a big shader's set-once uniforms into u_cfg (cluster-render keeps 32 names a layer)
    consts.js       the engine's limits and tables
    util.js         small helpers (isNum, rgb, rgba, mib, pad2, TEXT_MS)
  car/              the car's data and the values derived from it
    signals.js      the kit Car plus the app's extra SOME/IP signals, engine unit reads (UDS), guidance and media
    values.js       rpm smoothing, the shift point and rev scale, boost, pedals, brake, 12 V, tyres, odometer, ...
    lamps.js        parking brake / Auto Hold, indicators, cruise, the gear row's lit slot
    route.js        BMW's route guidance
    assist.js       driver assistance and the car ahead
    tokens.js       {{token}} -> text for text widgets (the token list is its header)
    consts.js       the car's enums and tables
    scales.js       BMW's speed scale
  widgets/
    index.js        the registry: type name -> module
    <type>/         one folder per type: index.js, shader.js (effect types), its helpers
                    (grid/ also holds gridlabels, swatch/ also swatchimg and calibration.js, icon/ icons.js,
                    miku/ sprite.js and idle.js, rdash/ its needle layer)
  layouts.js        layout files and their check (required fields come from the registry)
  hud_text.js, hud_themes.js, shift_score.js, sun.js, visible.js, ...   shared libraries
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
the theme (`hud.theme`) and paints through `hud._blit` / `hud._blitDiff`. `x` is the engine's state for the widget
(`x.w` the widget, `x.c` / `x.ref` its connection and layer, `x.last` the last values sent); a module keeps its own
state on it too and documents it in a typedef.

HudApp's methods live in several files: `engine/app.js` adds the methods of `engine/plan.js`, `status.js`, `modes.js`,
`assets.js` and `car/*.js` to its prototype (non-enumerable, as class methods are). Everything a type owns (its GLSL, its
helpers, its constants and state) lives in its folder; a type is removed by deleting its folder and its registry line.

GLSL comments still mention `hud.js` or `shaders.js` in places: the GLSL is sent to the car as it is, and the move
kept every shader byte for byte the same.

## Checks

- `node tools/shader_budget.js`: every widget type's shaders against what the KOMBI is known to take.
- The bench (`bench/README.md`) builds both apps into `dist/` and draws them as the car would.
