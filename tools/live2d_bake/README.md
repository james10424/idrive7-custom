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
5. Copy them to the car: see [Deploy to the car](#deploy-to-the-car).

## Deploy to the car

### Where the HUD looks

Custom HUD reads the frames from one fixed folder, `perch/`, inside its own data folder, and nowhere else:

```
<Custom HUD's app folder>/data/perch/atlas.json
<Custom HUD's app folder>/data/perch/atlas.rgba
```

Both files must be there, under exactly those names, straight from the bake (`atlas.rgba` must be exactly width x height x 4 bytes, as `atlas.json` says). `preview.png` is only for you and is not needed on the car. The app folder is `/var/opt/public/oap/oap_<id>/` on the car (OAP picks the id at install), so its data folder is `/var/opt/public/oap/oap_<id>/data/`.

### What you need

- Custom HUD installed on the car from the Store.
- SSH access to the car as root, from the computer you baked on.

### Steps

1. From the repo folder, run:

   ```bash
   ./scripts/deploy.sh root@<car> --perch <folder>
   ```

   `<folder>` is the bake's `--out` folder, the one with `atlas.json` and `atlas.rgba` in it. The script checks both files are there and the JSON is valid, finds Custom HUD's folder on the car (it looks for the `package.json` that names `custom_hud`), creates `data/perch/`, copies the two files in and gives them to the app's own user.

2. Make the app load them. It reads the frames only when it builds the layout, and does not watch the folder, so on the center screen open **Custom HUD**, pick another layout, then **Perch** again (or restart the app).

3. Check the app page's status row. With the frames loaded it says "HUD on", "Perch layout", "1 layer" and about "4.0 MiB of 16 MiB pixels". The app's log has a line like `perch frames: 14 of 106x250, tails, 1024x508 RGBA asset, 4.0 MiB of pixel memory`.

### By hand

Without the script, the same thing over SSH:

```bash
ssh root@<car> 'grep -l "\"name\": \"custom_hud\"" /var/opt/public/oap/oap_*/source/package.json'
```

That prints `.../oap_<id>/source/package.json`; the app folder is `/var/opt/public/oap/oap_<id>`. Then:

```bash
ssh root@<car> 'mkdir -p /var/opt/public/oap/oap_<id>/data/perch'
```

```bash
scp <folder>/atlas.json <folder>/atlas.rgba root@<car>:/var/opt/public/oap/oap_<id>/data/perch/
```

```bash
ssh root@<car> 'chown -R "$(stat -c %u:%g /var/opt/public/oap/oap_<id>/data)" /var/opt/public/oap/oap_<id>/data/perch'
```

### Updating or removing

- **New bake:** run the deploy again (it overwrites both files), then switch layouts again. The app sees the new files and replaces the old image.
- **Remove her:** delete `data/perch/` on the car. Perch then draws nothing.
- **Reinstalling or updating Custom HUD** from the Store keeps its data folder, as far as we know; if Perch says the frames are missing after an update, deploy again.

### When it doesn't show

The status row says why, after "Perch:":

| Status row | Meaning |
| --- | --- |
| `no baked frames in .../data/perch` | The folder or `atlas.rgba` is missing: deploy again. |
| `atlas.json: ...` or `Unexpected ...` | The JSON is not from this bake tool, or was cut short: deploy again. |
| `atlas.rgba is N bytes, ... needs M` | The two files don't belong together (one from an older bake): deploy both again. |
| `atlas asset refused` | cluster-render had no room: another app is using most of its 16 MiB of pixel memory. |

Nothing shows during route guidance either: that's on purpose, BMW's turn map uses her corner.

### On the bench

The bench's app data folder is `bench/.data/custom_hud/`, so copy the two files to `bench/.data/custom_hud/perch/` and press **Restart apps**. The bench data folder is ignored by git.

Not yet checked on a car: the app folder path (from the Store's docs) and SSH as root. `scripts/deploy.sh` says so too.

## What it makes

One image, 1024 px wide: her upright with eyes open, half shut and shut and with a smile, the same standing pose at 11 lean angles from a full lean left (braking face) to a full lean right (happy face), and the twin tails on their own. The angles are close enough that the HUD blends between neighbours without a double image. The model itself is never changed. On the car the GPU animates these: blinks, breathing, the lean as on a bus, and the tails following her head and streaming out with speed.
