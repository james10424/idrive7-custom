# Perch bake

Turns a Live2D model you own into the frames Custom HUD's **Perch** layout draws on the windshield, sitting on BMW's speed-limit sign or standing on it. It runs on your own computer. Nothing of your model goes in this repo or the app: the frames stay with you and go to your car only.

## What you need

- A Live2D model (Cubism 3 or newer: a `.model3.json` with its `.moc3` and textures), one you are allowed to use this way.
- **Cubism Core** for the web: download the Cubism SDK for Web from [live2d.com](https://www.live2d.com/en/sdk/download/web/) (you accept Live2D's license there) and use its `Core/live2dcubismcore.min.js`.
- Node.js and a browser.

## Bake

1. Write a config next to your model (the fields are listed at the top of `page.js`): which parameters make each expression, which parts are the twin tails, and, for sitting, where the hips and knees are.
2. Start the bake page:

   ```bash
   node tools/live2d_bake/serve.js --model <model>.model3.json --core <sdk>/Core/live2dcubismcore.min.js --config <bake>.json --out <folder>
   ```

3. Open `http://localhost:8095/?inspect` to see the model with a grid in model units, and every part on its own with its id. Use it to fill in the config.
4. Open `http://localhost:8095/` to bake. It writes `<folder>/sit/` and `<folder>/stand/`, each with `atlas.json`, `atlas.rgba` (what the car loads) and `preview.png`.
5. Copy them to the car:

   ```bash
   ./scripts/deploy.sh root@<car> --perch <folder>
   ```

   Then switch the Perch setting (or restart the app) to load them. On the bench, copy the folders to `bench/.data/custom_hud/perch/`.

## What it makes

Per pose, one image of up to 1024 px wide: six expressions of the body (idle, eyes half shut, shut, happy, braking, talking), the twin tails on their own, and, sitting, each shin on its own. For the sitting pose it bends the model's legs at the knee while drawing, so the model itself is never changed. On the car the GPU animates these: blinks, breathing, a sway, swinging tails and shins, and the happy and braking faces as you pull away and brake.
