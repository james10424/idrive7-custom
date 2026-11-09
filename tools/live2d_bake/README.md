# Miku bake

Turns a Live2D model you own into the frames Custom HUD's **Miku** layout draws on the windshield, standing in the bottom right corner. It runs on your own computer. Nothing of your model goes in this repo or the app: the frames stay with you and go to your car only.

## What you need

- A Live2D model (Cubism 3 or newer: a `.model3.json` with its `.moc3` and textures), one you are allowed to use this way.
- **Cubism Core** for the web: download the Cubism SDK for Web from [live2d.com](https://www.live2d.com/en/sdk/download/web/) (you accept Live2D's license there) and use its `Core/live2dcubismcore.min.js`.
- Node.js and a browser.

## Bake

1. Copy [`example.json`](example.json) next to your model and adjust it (every field is described at the top of `page.js`). As it is, it uses Live2D's standard parameter names, which most models have, so many models bake with it unchanged: a 200 px figure, blinking and smiling, leaning with its body and head, the braking and happy faces at the ends of the lean. A parameter your model doesn't have is skipped, with a note in the bake log. What you will most likely change:
   - `tails`: the part ids of long hair or ribbons to swing in their own sprite (find them on the inspect page). Leave it empty and the hair simply leans with her.
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

3. Check the app page's status row. With the frames loaded it says "HUD on", "Miku layout", "1 layer" and about "4.4 MiB of 16 MiB pixels" (it depends on the bake). The app's log has a line like `miku frames: 23 of 144x278, tails, 1024x564 RGBA asset, 4.4 MiB of pixel memory`.

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

### The forward/back lean

The **Miku lean** setting on the app page picks Sideways (the bake in `data/miku/`) or Forward and back (`data/miku-fb/`). The forward/back one is a second bake from a copy of your config with `"axis": "fb"` in `lean`, and `lean.params` tipping her back, away from you, at a full lean right (pulling away, as if pressed into a seat), for example `{ "ParamBodyAngleY": 10, "ParamAngleY": 30, "ParamEyeBallY": -0.6 }` (negated, she leans toward you when braking). Bake it to its own `--out` folder and deploy it with:

```bash
./scripts/deploy.sh root@<car> --miku-fb <folder>
```

The bake draws these frames in perspective too, so the lean reads in depth: above the waist her upper body gets shorter as she tips out of the screen, its top narrower leaning back and wider leaning toward you. `"perspective": { "widen": 0.14, "shorten": 0.1 }` in `lean` sets how much (0 for none). The bake log has "head drop per lean angle": it should be largest at the left end (her head going down as she leans toward you, braking). If the right end is larger, flip the signs. Switching the setting rebuilds the layout and swaps the uploaded image: the old one is dropped first, so only one is in the cluster's memory.

### Sitting (Custom Cluster)

For now no theme places her (Regal had her in 0.1.36; tools/gen_regal.py says how to put her back). The engine still draws her as a `mikuSit` widget: sitting on the ledge between the speed window and the lower window, at its left end, facing you, her legs hanging over the boost bar and swinging. That's a bake of its own, from a copy of your config with:

- `"pose": "sit"`, and `"heightPx"` (290 with RetrynowMiku: her feet reach the boost bar).
- `"sit"`: the bake's own rig on the model's meshes (the model's compiled rig can't be changed):
  - `leg`: the part holding both legs; `hip`, `knee`: the model y where her thighs turn (under the skirt) and of her knees; `split`: the model x between her legs. The thighs point at you, so they're drawn short (`thigh`, 0.25 of their length); everything below the knees moves up by as much, and each shin becomes its own sprite, which the cluster swings.
  - `together`: pulls her legs in toward `split` below the hips, fully from the knees down (0 as drawn, 0.35 with RetrynowMiku: knees and feet a third closer). The skirt's sag over the knees follows.
  - `skirt`: the skirt's parts. It rests on her lap: below the hips its flare is pulled in (`narrow`, 0.2), its hem reaches just past the knees (`drape`, 0.06 model units) and sags over each knee (`sag`, 0.06, at `kneeX` either side of `split`). Meshes in those parts that hang below the knees (ribbons) aren't skirt.
  - `hands`: her hands rest on the ledge: each arm in the config's `arms` (the HUD bake's, `Part16` and `Part17` with RetrynowMiku) is turned out from its shoulder until its palm's bottom edge (the thumb hangs below it, over the edge) is `hands` model units above the knees (0.03 with RetrynowMiku: about 4 px, the speed window's bottom edge). The frame widens to fit them. Leave it out to keep the arms as drawn.
  - `behind`: what hangs behind her (a back bow's ribbons): tucked under the skirt, onto the seat (`tuck`, 0.1 of its length shows).

With RetrynowMiku: `{ "leg": "Part15", "hip": 0.45, "knee": -0.68, "thigh": 0.25, "split": 0, "together": 0.35, "hands": 0.03, "skirt": ["Part64", "Part11", "Part18"], "behind": ["ArtMesh117_Skinning", "ArtMesh118_Skinning"] }`. The bake page shows her as the cluster draws her, under the atlas. With `"arms": [{ "parts": ["Part16"] }, { "parts": ["Part17"] }]` too. The atlas is 512x233 (0.9 MiB of the cluster's pixel memory): her body, her face with eyes half shut and shut, and the two shins. Deploy to Custom Cluster (the script finds that app by itself):

```bash
./scripts/deploy.sh root@<car> --miku-sit <folder>
```

It lands in Custom Cluster's `data/miku-sit/`; switch the theme away and back (or restart the app). The shader reads 5 pixels of the image per screen pixel, against the 32 Custom HUD's Miku reads.

### Updating or removing

- **New bake:** run the deploy again (it overwrites both files), then switch layouts again. The app sees the new files and replaces the old image.
- **Remove her:** delete `data/miku/` on the car. Miku then draws nothing.
- **Reinstalling or updating Custom HUD** from the Store keeps its data folder, as far as we know; if Miku says the frames are missing after an update, deploy again.

### When it doesn't show

The status row says why, after "Miku:":

| Status row | Meaning |
| --- | --- |
| `no baked frames in .../data/miku` (or `miku-fb`) | The folder or `atlas.rgba` is missing: deploy again (`--miku-fb` for the forward/back lean). |
| `atlas.json: ...` or `Unexpected ...` | The JSON is not from this bake tool, or was cut short: deploy again. |
| `atlas.rgba is N bytes, ... needs M` | The two files don't belong together (one from an older bake): deploy both again. |
| `atlas WxH is over 1024 px a side` | A bake from an older tools/live2d_bake: bake again and deploy it. The app won't upload it (a precaution, see [What the cluster can take](#what-the-cluster-can-take)). |
| `atlas asset refused` | cluster-render had no room: another app is using most of its 16 MiB of pixel memory. |

Nothing shows during route guidance either: that's on purpose, BMW's turn map uses her corner.

### On the bench

The bench's app data folder is `bench/.data/custom_hud/`, so copy the two files to `bench/.data/custom_hud/miku/` and press **Restart apps**. The bench data folder is ignored by git.

Not yet checked on a car: the app folder path (from the Store's docs) and SSH as root. `scripts/deploy.sh` says so too.

## What it makes

One image, at most 1024 px a side: her upright with eyes open, half shut and shut and with a smile, the same standing pose at 11 lean angles from a full lean left (braking face) to a full lean right (happy face), glancing left and right (head and eyes, 3 angles each way, from `look`), dozing (head drooping, eyes shut, 3 frames, from `doze`), the twin tails on their own, and (with `arms` in the config) each arm on its own, which the HUD swings up from the shoulder to point toward the indicator. The angles are close enough that the HUD blends between neighbours without a double image. The face, glance and doze frames differ from upright only around her head, so each keeps just that crop (one rect for all of them); the HUD draws the upright frame round it. The model itself is never changed.

With your model the atlas is 1024x564 (4.4 MiB of pixel memory). On the car the GPU animates these: blinks, breathing, the lean as on a bus, glances and dozing, and the tails following her head and streaming out with speed.

## What the cluster can take

The HUD is drawn by the instrument cluster's own GPU (the KOMBI), and it has a limit on how big a shader can be. Past it, the KOMBI restarts about 2 s after the HUD appears. That blanks the cluster for a few seconds. After two restarts in a row, cluster-render's guard turns the HUD off until you reset it.

What we found on a 2020 M340i (cluster-render 0.4.5, Nov 9 2026):

- **The shader is the limit, not the image.** Custom HUD 0.1.9 to 0.1.15 all restarted the KOMBI, even with the atlas cut from 1024x1128 to 1024x564, below the 1024x846 that had run fine. Cutting the shader's uniforms from 55 vectors to 29 and removing its loops (0.1.14) wasn't enough either.
- **The parts ran alone but not together.** With the "Miku parts" setting (0.1.15), every subset held: no legs, no glances or dozing, and only the lean. All of her at once (legs plus glances and dozing) restarted it straight away.
- **What runs now (0.1.16):** the lean with its faces, blinks and the smile, breathing, the arms, the tails, glances and dozing. The legs as their own bending sprites are gone; her legs are part of the body frames again.

- **What sets the crash apart is the texture reads.** Counted as the GPU compiler sees them (every function inlined into `main`, so a sprite drawn 6 times counts 6 reads), 0.1.15 with all parts made **38** reads of the atlas and 0.1.16 makes **32**. Size alone isn't it: Custom Cluster's Sport shader is bigger than the one that crashed (7835 tokens against 7008) and runs, but reads no textures.

**Caught on the bench:** [tools/shader_budget.js](../shader_budget.js) measures every effect shader. The bench refuses a layer at 38 reads or more ("shader 38 texture reads ...: 38 reads restarted the instrument cluster"), and logs a warning over 32 reads or over Sport's size, which no shader has tried on the car. `node tools/shader_budget.js` lists every shader in shared/shaders.js, the Miku parts included, and exits 1 if one reaches the crash mark. Where the limit really sits between 32 and 38 is unknown.

So treat today's shader as about the ceiling. Anything new needs code taken out first, for example per-pixel maths moved into the app and sent as a few uniforms. Put it behind the "Miku parts" setting so the car can test it without a new release.

We still refuse an atlas over 1024 px a side, in the bake and in the app. It cost nothing to keep, though the 1024x1128 crash was most likely the shader too.

**If the cluster restarts:** park, and on the car's center screen set Custom HUD's layout to Off, or "Miku parts" to Bare. Then, as root on the car:

```bash
cat /var/opt/cluster-render/state/guard.txt
```

```bash
rm -f /var/opt/cluster-render/state/guard.txt && systemctl restart cluster-render.service
```

The first shows whether the guard has turned the HUD off (`hud 0x323 ...` with 2 strikes); the second clears it. `cluster-render guard-reset` does the same, but the command isn't on the car's PATH: run `/var/opt/cluster-render/current/cluster-render -c /var/opt/cluster-render/current/cluster-render.conf guard-reset`. Copy cluster-render's log for a look: `scp root@<car>:/var/opt/cluster-render/log/cluster-render.log .`
