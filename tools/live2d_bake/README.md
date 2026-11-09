# Miku bake

Turns a Live2D model you own into the frames Custom HUD's **Miku** layout draws on the windshield, standing in the bottom right corner. It runs on your own computer. Nothing of your model goes in this repo or the app: the frames stay with you and go to your car only.

## What you need

- A Live2D model (Cubism 3 or newer: a `.model3.json` with its `.moc3` and textures), one you are allowed to use this way.
- **Cubism Core** for the web: download the Cubism SDK for Web from [live2d.com](https://www.live2d.com/en/sdk/download/web/) (you accept Live2D's license there) and use its `Core/live2dcubismcore.min.js`.
- Node.js and a browser.

## Bake

1. Copy [`example.json`](example.json) next to your model and adjust it (every field is described at the top of `page.js`). As it is, it uses Live2D's standard parameter names, which most models have, so many models bake with it unchanged: a 200 px figure, blinking and smiling, leaning with its body and head, the braking and happy faces at the ends of the lean. A parameter your model doesn't have is skipped, with a note in the bake log. What you will most likely change:
   - `tails`: the part ids of long hair or ribbons to swing in their own sprite (find them on the inspect page). Leave it empty and the hair simply leans with her.
   - `legs`: each leg's drawable or part ids, shoe included (find them on the inspect page), so the HUD can plant her feet and bend her knees. Leave it empty and the legs stay in the body frames, straight.
   - `lean.left` and `lean.right`: your model's own expressions for braking and pulling away hard (its `.exp3.json` files show which parameters they set).
   - `params`: toggles to set on every frame, such as an outfit.
   - `heightPx`, `anchor`, `headY`, `waist`: her size, the point between her feet, her face and waist (by default 15% and 40% down the figure).
2. Start the bake page:

   ```bash
   node tools/live2d_bake/serve.js --model <model>.model3.json --core <sdk>/Core/live2dcubismcore.min.js --config <bake>.json --out <folder>
   ```

3. Open `http://localhost:8095/?inspect` to see the model with a grid in model units, and every part on its own with its id. Use it to fill in the config.
4. Open `http://localhost:8095/` to bake. It writes `atlas.json`, `atlas.rgba` (what the car loads) and `preview.png` to the folder.
5. Copy them to the car: see [Deploy to the car](#deploy-to-the-car).

## Deploy to the car

### Where the HUD looks

Custom HUD reads the frames from one fixed folder, `miku/`, inside its own data folder, and nowhere else:

```
<Custom HUD's app folder>/data/miku/atlas.json
<Custom HUD's app folder>/data/miku/atlas.rgba
```

Both files must be there, under exactly those names, straight from the bake (`atlas.rgba` must be exactly width x height x 4 bytes, as `atlas.json` says). `preview.png` is only for you and is not needed on the car. The app folder is `/var/opt/public/oap/oap_<id>/` on the car (OAP picks the id at install), so its data folder is `/var/opt/public/oap/oap_<id>/data/`.

### What you need

- Custom HUD installed on the car from the Store.
- SSH access to the car as root, from the computer you baked on.

### Steps

1. From the repo folder, run:

   ```bash
   ./scripts/deploy.sh root@<car> --miku <folder>
   ```

   `<folder>` is the bake's `--out` folder, the one with `atlas.json` and `atlas.rgba` in it. The script checks both files are there and the JSON is valid, finds Custom HUD's folder on the car (it looks for the `package.json` that names `custom_hud`), creates `data/miku/`, copies the two files in and gives them to the app's own user.

2. Make the app load them. It reads the frames only when it builds the layout, and does not watch the folder, so on the center screen open **Custom HUD**, pick another layout, then **Miku** again (or restart the app).

3. Check the app page's status row. With the frames loaded it says "HUD on", "Miku layout", "1 layer" and about "8.8 MiB of 16 MiB pixels" (it depends on the bake). The app's log has a line like `miku frames: 23 of 144x278, tails, 1024x1128 RGBA asset, 8.8 MiB of pixel memory`.

### By hand

Without the script, the same thing over SSH:

```bash
ssh root@<car> 'grep -l "\"name\": \"custom_hud\"" /var/opt/public/oap/oap_*/source/package.json'
```

That prints `.../oap_<id>/source/package.json`; the app folder is `/var/opt/public/oap/oap_<id>`. Then:

```bash
ssh root@<car> 'mkdir -p /var/opt/public/oap/oap_<id>/data/miku'
```

```bash
scp <folder>/atlas.json <folder>/atlas.rgba root@<car>:/var/opt/public/oap/oap_<id>/data/miku/
```

```bash
ssh root@<car> 'chown -R "$(stat -c %u:%g /var/opt/public/oap/oap_<id>/data)" /var/opt/public/oap/oap_<id>/data/miku'
```

### Updating or removing

- **New bake:** run the deploy again (it overwrites both files), then switch layouts again. The app sees the new files and replaces the old image.
- **Remove her:** delete `data/miku/` on the car. Miku then draws nothing.
- **Reinstalling or updating Custom HUD** from the Store keeps its data folder, as far as we know; if Miku says the frames are missing after an update, deploy again.

### When it doesn't show

The status row says why, after "Miku:":

| Status row | Meaning |
| --- | --- |
| `no baked frames in .../data/miku` | The folder or `atlas.rgba` is missing: deploy again. |
| `atlas.json: ...` or `Unexpected ...` | The JSON is not from this bake tool, or was cut short: deploy again. |
| `atlas.rgba is N bytes, ... needs M` | The two files don't belong together (one from an older bake): deploy both again. |
| `atlas asset refused` | cluster-render had no room: another app is using most of its 16 MiB of pixel memory. |

Nothing shows during route guidance either: that's on purpose, BMW's turn map uses her corner.

### On the bench

The bench's app data folder is `bench/.data/custom_hud/`, so copy the two files to `bench/.data/custom_hud/miku/` and press **Restart apps**. The bench data folder is ignored by git.

Not yet checked on a car: the app folder path (from the Store's docs) and SSH as root. `scripts/deploy.sh` says so too.

## What it makes

One image, 1024 px wide: her upright with eyes open, half shut and shut and with a smile, the same standing pose at 11 lean angles from a full lean left (braking face) to a full lean right (happy face), glancing left and right (head and eyes, 3 angles each way, from `look`), dozing (head drooping, eyes shut, 3 frames, from `doze`), the legs on their own (from `legs`, which the HUD bends at the knee with the feet planted), the twin tails on their own, and (with `arms` in the config) each arm on its own, which the HUD swings up from the shoulder to point toward the indicator. The angles are close enough that the HUD blends between neighbours without a double image. The model itself is never changed. On the car the GPU animates these: blinks, breathing, the lean as on a bus, and the tails following her head and streaming out with speed.
