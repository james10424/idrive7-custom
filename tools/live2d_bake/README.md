# Perch bake

Turns a Live2D model you own into the frames Custom HUD's **Perch** layout draws on the windshield, standing in the bottom right corner. It runs on your own computer. Nothing of your model goes in this repo or the app: the frames stay with you and go to your car only.

## What you need

- A Live2D model (Cubism 3 or newer: a `.model3.json` with its `.moc3` and textures), one you are allowed to use this way.
- **Cubism Core** for the web: download the Cubism SDK for Web from [live2d.com](https://www.live2d.com/en/sdk/download/web/) (you accept Live2D's license there) and use its `Core/live2dcubismcore.min.js`.
- Node.js and a browser.

## Bake

1. Write a config next to your model (the fields are listed at the top of `page.js`): which parameters make the blink and the smile, which parts are the twin tails, and which body and head rotation makes her lean.
2. Start the bake page:

   ```bash
   node tools/live2d_bake/serve.js --model <model>.model3.json --core <sdk>/Core/live2dcubismcore.min.js --config <bake>.json --out <folder>
   ```

3. Open `http://localhost:8095/?inspect` to see the model with a grid in model units, and every part on its own with its id. Use it to fill in the config.
4. Open `http://localhost:8095/` to bake. It writes `atlas.json`, `atlas.rgba` (what the car loads) and `preview.png` to the folder.
5. Copy them to the car:

   ```bash
   ./scripts/deploy.sh root@<car> --perch <folder>
   ```

   Then switch to another layout and back (or restart the app) to load them. On the bench, copy the two atlas files to `bench/.data/custom_hud/perch/`.

## What it makes

One image, 1024 px wide: her upright with eyes open, half shut and shut and with a smile, the same standing pose at 11 lean angles from a full lean left (braking face) to a full lean right (happy face), and the twin tails on their own. The angles are close enough that the HUD blends between neighbours without a double image. The model itself is never changed. On the car the GPU animates these: blinks, breathing, the lean as on a bus, and the tails following her head and streaming out with speed.
