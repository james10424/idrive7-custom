# Custom HUD

Puts your own Live2D character on the windshield HUD, beside BMW's own speed and speed-limit sign. Open **Custom HUD** from the apps menu on the center screen to turn her on or off.

<p align="center"><img src="../../docs/images/hud-miku-lean.gif" width="485" alt="Miku layout"><br><sub>Driving: she leans as the car pulls away and brakes, beside BMW's own speed and speed-limit sign (bottom left)</sub></p>

<p align="center"><img src="../../docs/images/hud-miku-zoom.gif" width="485" alt="Miku close-up on the HUD"><br><sub>Stopped: after 1 s she zooms into the close-up, filling the window from BMW's speed to the right edge, and zooms back out as the car moves off</sub></p>

<p align="center"><sub>Miku in the screenshots: the free Hatsune Miku "いますぐ輪廻" fan model by [Ruby_鸣哔うび](https://ko-fi.com/rubybee) (art) and 慈善小霓 (Live2D rigging), used under its personal, non-commercial terms. No model files are in this repo; you bake and copy your own model to your car.</sub></p>

## Miku

- **Miku**, the only layout since 0.1.24 (Daily and Sport are gone; a HUD set to either shows Miku): a Live2D character you own stands at the bottom right of the HUD, clear of BMW's speed and speed-limit sign. No readouts of our own, just her and BMW's HUD. After sunset she dims a little.
  - **Bring your own model:** no character ships with the app. You bake frames from a Live2D model on your own computer with [tools/live2d_bake](../../tools/live2d_bake/README.md) and copy them to the car with `scripts/deploy.sh <car> --miku <folder>` (the short version is in the main README, [Your own Live2D character](../../README.md#your-own-live2d-character); the full one in [deployment steps](../../tools/live2d_bake/README.md#deploy-to-the-car)). The app reads them from `miku/` in its data folder. Until they're there the layout draws nothing and the status row says why.
  - **Like standing on a bus:** pull away and she leans right, brake and she leans left, with the model's own body and head moving (her happy face when you pull away hard, her braking face when you brake hard). When the car settles she straightens smoothly, without swaying past upright. Her arm on the side away from the lean swings up and out to catch her balance (the other a little), and her twin tails move with her head.
  - **Idle:** she blinks, breathes, sways a little and smiles as if talking now and then. The faster you go, the more her twin tails spread, lift and flutter.
  - **Close-up when stopped:** after 1 s at a standstill the view zooms in over 1 s to her head and chest, filling the window from BMW's speed to the right edge. On the way in her expressions blend on (with RetrynowMiku: hands on her cheeks, star eyes, blushing). Zoomed in she blinks every 2 s and sways her head gently (4 s each way and back); with the indicator on she turns her head toward it and holds still. Past 10 km/h she zooms back out to standing in 1 s. The close-up needs its own bake (`close` in the bake config) and room in cluster-render's pixel memory (our fork's 32 MiB): without either she just stands.
  - **Reset Miku** on the app page puts her back to standing upright at once, as if nothing had happened (the close-up out, the lean and timers at rest), and switches itself off again.
  - **During route guidance** she steps aside, because BMW's turn map and street name fill her corner; she comes back when the route ends.
  - The frames go up once as two ETC2-compressed images (about 0.6 MiB standing and 0.9 MiB for the close-up; this needs cluster-render 0.5.9 or later), and the GPU animates them on cluster-render's own clock: two layers, standing and the close-up over her, and only a tiny update goes up while she moves.
  - **The cluster's GPU limits her.** A bigger shader restarted the instrument cluster: legs that bend, together with the glances (gone since 0.1.21), were too much, though each ran alone. The close-up is a shader of its own, so neither shader grows. Split over two shaders, all of her runs on the car. See [What the cluster can take](../../tools/live2d_bake/README.md#what-the-cluster-can-take) for what was tested and how to recover.
  - Redline is gone: if you had it picked anywhere, it switches to Miku (so does Perch, its working name).

## Off

- **Off (BMW's own HUD):** pick it as the layout and the app draws nothing, so BMW's HUD comes back. Miku shows in every drive mode.
- **With Custom Cluster:** both show together on cluster-render 0.5.1 or later (the panel has its own scene id). On older versions, or if the KOMBI refuses the panel's id, they take turns; see [Both apps at once](../../README.md#both-apps-at-once).

## Settings

Layout (Off, Miku or the calibration grid), Make room for BMW's guidance and cruise display, Reset Miku, and demo data. Changes show on the HUD right away, and the HUD keeps running after you leave the page.

The page's first row says what the HUD is doing and why anything is not drawn (for example "waiting: another app has this display").

## The visible window

The HUD is an 800x480 screen, but only part of it comes through the windshield. Measured from a photo of the calibration grid on a 2020 M340i (Nov 12 2026), the visible window is **x 120, y 100, 560 x 280** (x 120 to 680, y 100 to 380). It moves a little with eye position and HUD height, and every layout sits inside it.

BMW keeps drawing its own HUD content over ours. In Comfort mode that is the speed readout and the speed-limit sign in the bottom-left of the window, so Miku keeps **x 150..355, y 314..378** free for it.

**Calibration grid:** pick it as the layout to see lines every 50 px with labels on the glass. A photo of it shows exactly which part of the HUD is visible; take a new one if the HUD height or the seat changes a lot. The grid also carries a few test marks used to measure cluster-render's limits on the car.

## Requirements

[cluster-render](https://github.com/robertnisipeanu/idrive-apps), installed from the `robertnisipeanu/idrive-apps` Store source or `james10424/idrive-apps-lib`, 0.5.1 or later to show together with the other app. Without it, the status row reads "HUD off: cluster-render is not installed or not running".

## On the car

Tested on a 2020 BMW M340i (G20): Miku leans, zooms into her close-up when stopped, blinks and sways there, and turns toward the indicator.

Version history is in the repo's [CHANGELOG.md](../../CHANGELOG.md).
