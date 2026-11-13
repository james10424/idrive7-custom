<h1 align="center">idrive7-custom</h1>

<p align="center">Apps for BMW iDrive 7 head units (MGU), installed through the community MGU Store. A reworked fork of [bimmer-lab/apps](https://github.com/bimmer-lab/apps) whose apps install next to the originals: they have their own ids (`custom_hud`, `custom_cluster`).</p>

## Custom Cluster

Redraws the whole instrument cluster as a 1987 Buick Grand National dash, and switches to a Sport view round BMW's map while route guidance is on. [Read more](apps/custom_cluster/README.md)

<p align="center"><img src="docs/images/cluster-regal.gif" width="900" alt="Grand National theme"><br><sub>Grand National: the speed over the 55, the voltmeter and oil temperature pods with the range and clock, the rolling odometer under the 55 and P R N D S with its needle in the left pod</sub></p>

<p align="center"><img src="docs/images/cluster-sport.gif" width="900" alt="Sport theme while navigating"><br><sub>Sport while navigating: BMW's map shows in the middle (black here), the route's progress along the bottom</sub></p>

## Custom HUD

Puts your own Live2D character on the windshield HUD, standing beside BMW's speed and speed-limit sign: she leans as the car pulls away and brakes, and at a stop the view zooms in to a close-up of her, blinking, swaying and looking toward the indicator. It makes room for BMW's own HUD content: the layout steps aside while route guidance is up. [Read more](apps/custom_hud/README.md)

<p align="center"><img src="docs/images/hud-miku-lean.gif" width="485" alt="Miku layout on the HUD"><br><sub>Driving: she leans as the car pulls away and brakes, beside BMW's own speed and speed-limit sign (bottom left)</sub></p>

<p align="center"><img src="docs/images/hud-miku-zoom.gif" width="485" alt="Miku close-up on the HUD"><br><sub>Stopped: after 1 s she zooms into the close-up, filling the window from BMW's speed to the right edge, and zooms back out as the car moves off</sub></p>

<p align="center"><sub>Miku in the screenshots: the free Hatsune Miku "いますぐ輪廻" fan model by [Ruby_鸣哔うび](https://ko-fi.com/rubybee) (art) and 慈善小霓 (Live2D rigging), used under its personal, non-commercial terms. No model files are in this repo; you bake and copy your own model to your car.</sub></p>

## Install

1. Install **cluster-render** first. Both apps draw through it. Use 0.5.1 or later so both apps can show at once: either the `robertnisipeanu/idrive-apps` Store source or `james10424/idrive-apps-lib` (see [Both apps at once](#both-apps-at-once)).
2. In the Store, go to **Settings, Add source**, enter **`james10424/idrive7-custom`**, and install the apps you want.
3. Open the app from the apps menu on the center screen to pick a theme or layout.
4. For the Miku layout, bake your own Live2D model and copy it to the car: see [Your own Live2D character](#your-own-live2d-character).

The Store builds each app on the car from this repo. No BMW code is in it. Both apps are tested on a 2020 BMW M340i (G20); each app's page says what has been checked on the car and what is still open. Version history is in [CHANGELOG.md](CHANGELOG.md).

### Local deployment over SSH

To try a build on the car before releasing it, install it the way the Store does, with mgu-store's deploy tool (a checkout of `mgu-store` beside this repo, and SSH as root to the car; `deploy/hu connect` finds it, see mgu-store's `deploy/README.md`).

1. **Once, get the real oap-sdk from the car.** BMW's SDK is built into every stock app, so copy one off the car (`oap_12204` is x_call, the example in `kit/tools/extract_sdk.js`; any stock BMW app works):

   ```bash
   mkdir -p ~/oap-donor/javascript
   scp root@<car>:/var/opt/public/oap/oap_12204/source/package.json ~/oap-donor/
   scp root@<car>:/var/opt/public/oap/oap_12204/source/javascript/app.js ~/oap-donor/javascript/
   ```

2. **Build** with it (`oap-sdk/` is gitignored; the extract replaces the bench's stub there):

   ```bash
   node kit/tools/extract_sdk.js ~/oap-donor/javascript/app.js oap-sdk
   python3 kit/tools/build.py custom_hud
   ```

   This writes `dist/custom_hud@<version>.tgz` (`custom_cluster` the same way).

3. **Install** it, as the renderer test was:

   ```bash
   ../mgu-store/deploy/hu install --artifact dist/custom_hud@<version>.tgz
   ```

   The deploy tool marks it local (`"mguLocalOnly": true`).

### When the HUD or the cluster stays off (the guard)

If the KOMBI restarts twice right after cluster-render shows a display (a shader it can't draw, say), cluster-render's guard turns that display off, even across reboots, and the app's status row says "cluster-render's guard disabled this display". Find out why first, or the next try restarts it again:

```bash
ssh root@<car> 'grep -E "guard|refused|error" /var/opt/cluster-render/log/cluster-render.log | tail -40'
```

Then reset it as root. `cluster-render` isn't on the car's `PATH`, so run the installed binary:

```bash
ssh root@<car> '/var/opt/cluster-render/current/cluster-render -c /var/opt/cluster-render/current/cluster-render.conf guard-reset'
```

It removes `/var/opt/cluster-render/state/guard.txt` and restarts cluster-render. Doing that by hand is the same:

```bash
ssh root@<car> 'rm -f /var/opt/cluster-render/state/guard.txt && systemctl restart cluster-render'
```

## Both apps at once

From cluster-render 0.5.1 on, the cluster panel has a scene id of its own (0x010004f8) and the HUD keeps 0x01000400, so Custom HUD and Custom Cluster show together with nothing to set. Before 0.5.1 they shared 0x01000400 and only one showed at a time: whichever asked first kept it, and the other waited ("waiting: the cluster layout has the scene the HUD shares" on Custom HUD's page). That message can still come back if the KOMBI refuses the panel's own id: cluster-render then falls back to the shared one for the rest of the boot and logs it.

The two sources differ in what the HUD gives way to:

- `robertnisipeanu/idrive-apps`: BMW's HUD lists (media source list, playlists, recent calls). Calls and apps' pop-ups only with `hud_yield_slots = 0x321,0x322` in the local conf.
- `james10424/idrive-apps-lib`: those lists, calls and apps' pop-ups, and BMW's route guidance.

Either way Custom HUD's own "Make room for BMW's guidance and cruise display" setting turns Miku off while BMW guides.

If the panel keeps falling back, `james10424/idrive-apps-lib` (0.4.5 or later) can move the HUD instead. The HUD then takes turns with cluster-render's `map` target (the Waze map on the cluster), not with the panel:

1. Over SSH as root, add the line to cluster-render's local conf (updates keep this file) and restart it:

   ```bash
   ssh root@<car> 'echo "hud_scene_id = 0x010004f0" >> /var/opt/cluster-render/cluster-render.local.conf && systemctl restart cluster-render'
   ```

2. Check it took:

   ```bash
   ssh root@<car> 'grep "target hud: .*0x10004f0" /var/opt/cluster-render/log/cluster-render.log | tail -1'
   ```

To undo, delete the line and restart cluster-render.

## Your own Live2D character

The Miku layout draws a Live2D model you own. Nothing of it ships with the app: you render it into frames on your computer and copy them to your car. Full details, including every bake setting, are in [tools/live2d_bake/README.md](tools/live2d_bake/README.md).

1. **What you need:** a Live2D model (Cubism 3 or newer: a `.model3.json` with its `.moc3` and textures) that you are allowed to use this way; Live2D's **Cubism Core** for the web (`Core/live2dcubismcore.min.js` from the [Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/), under Live2D's license); Node.js and a browser.
2. **Configure:** copy [tools/live2d_bake/example.json](tools/live2d_bake/example.json) next to your model. It uses Live2D's standard parameter names, so many models bake as it is. Set `lean.left` / `lean.right` to your model's braking and happy expressions, and `tails` to the part ids of long hair or ribbons to swing on their own.
3. **Bake:**

   ```bash
   node tools/live2d_bake/serve.js --model <model>.model3.json --core <sdk>/Core/live2dcubismcore.min.js --config <bake>.json --out <folder>
   ```

   Open `http://localhost:8095/?inspect` to see every part with its id (to fill in the config), then `http://localhost:8095/` to bake. It writes `atlas.json`, `atlas.etc2` and, with `close` in the config, `close.etc2` (ETC2, what the car loads; cluster-render 0.5.9 or later), the same as `.rgba`, and `preview.png` (for you) to `<folder>`. The bake refuses an atlas over 1024 px a side.
4. **Copy to the car** (Custom HUD installed, SSH as root):

   ```bash
   ./scripts/deploy.sh root@<car> --miku <folder>
   ```

   It finds Custom HUD's folder on the car and puts the bake's files in its `data/miku/`.
5. **Load:** on the center screen open **Custom HUD**, pick another layout, then **Miku** again. The status row should say "HUD on: Miku layout, 1 layer". Until the frames are there, the layout draws nothing and the status row says why.

To change her, bake again and run the deploy again; to remove her, run `./scripts/remove-miku.sh root@<car> --miku`.

## Credits

- [bimmer-lab/apps](https://github.com/bimmer-lab/apps) (MIT): the original HUD Widgets and Cluster Themes this repo starts from.
- [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps): the MGU App Kit (MIT) these apps are built on, and the Redline app the shift scoring comes from.
- [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps): cluster-render, which draws on the HUD and the cluster.
- Barlow and Michroma typefaces (SIL Open Font License).
- The free Hatsune Miku "いますぐ輪廻" fan model by [Ruby_鸣哔うび](https://ko-fi.com/rubybee) (art) and 慈善小霓 (Live2D rigging), used under its personal, non-commercial terms. No model files are in this repo; you bake and copy your own model to your car.
- [Live2D Cubism](https://www.live2d.com/): the bake runs on Cubism Core, which you download from Live2D yourself (not in this repo).

## Licence

MIT. Third-party parts are listed in each app's `NOTICE`. To work on the apps, see [docs/DEVELOPING.md](docs/DEVELOPING.md).
