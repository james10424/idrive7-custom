# Live2D Render

Draws a Live2D model live on the head unit's GPU for an app, and shows it as a
[cluster-render](https://github.com/robertnisipeanu/idrive-apps) video layer (the HUD by default).
The app sends the model's parameter values as often as it likes; live2d-render
draws at the frame rate the app asked for, with the model's physics (hair,
clothes) on top. It knows nothing about any particular model: what the model
does is the app's (Custom HUD's "Miku Live2D" layout, for one).

iDrive 7 only. It is the one process here that drives the GPU itself, at CPU
priority (nice) 19, so BMW's HMI always comes first (0.1.6 to 0.1.9 ran at
10, so a burst such as the Store starting wouldn't stall her frames; at 10 the
car's display service went down on a busy start, Nov 23 2026). On a 2020 G20's head unit,
RetrynowMiku's close-up at 15 fps takes about 39% of each frame's time and
29% of one CPU core ([Performance on the car](#performance-on-the-car)).

## Performance on the car

Measured on a 2020 M340i (G20) head unit, Nov 14 and 15 2026: Intel Atom (4
cores) with Intel HD Graphics 505 (Broxton), Mesa 19.0.6, OpenGL ES 3.2.

**The model**, RetrynowMiku (Cubism 5), as Custom HUD's Miku Live2D draws it:

| | |
| --- | --- |
| Drawables | 484 |
| Vertices | 65,368 (all drawables together) |
| Triangles | 96,230 (288,690 indices) |
| Clipping masks | 59, in 2 mask textures of 256 px (one holds 36) |
| Parameters | 232; the HUD drives 137 of them |
| Physics | 39 settings: 95 inputs, 167 outputs, 138 particles |
| Moc | 6.9 MB |
| Textures | 17, shrunk from 4096 to 1024 px (38 MB of PNG to 5.5 MB), no mipmaps |
| Picture | 324x278 (248x280 before Custom HUD 0.1.42), 15 fps, 4:2:0 to cluster-render |

**A frame** (live2d-render's own timing line, every 5 s; a frame has 67 ms at
15 fps):

| Part | ms | |
| --- | --- | --- |
| Cubism Core (the moc's update) | ~10.3 | Live2D's closed library: deforms the 65,368 vertices from the parameters |
| Physics | ~0.85 | the Framework's, 39 settings |
| Drawing | ~12.6 | the masks, then the 484 drawables, with `glue/apply_fast.py` |
| 4:2:0 and reading it back | ~1.95 | on the GPU (`src/gpu.cpp`), 1.5 bytes a pixel read |
| **Together** | **~25.7** | **37 to 41% of the frame**, a steady 15.1 to 15.2 fps |

**How it got there** (248x280, the same model; the first rows from a test
program with the same drawing code):

| Step | Update | Draw | Read + 4:2:0 | Of a frame |
| --- | --- | --- | --- | --- |
| Stock Cubism renderer, 4:2:0 on the CPU | 10.8 | 19.5 (masks 6.4, model 14.3) | 1.9 + 3.6 | 54% |
| 4:2:0 on the GPU | 10.8 | 19.5 | 1.2 + 0.65 | 50% |
| Patched renderer (one vertex upload a frame, GL state only when it changes) | 10.5 | 12.8 (masks 5.2, model 7.6) | 1.9 | 39% |
| Two frames in flight (0.1.4, on the car Nov 16 2026: draw is the CPU's part only) | 7.3 | 8.7 | 0.7 | 25% |

Batched draws (the glue, Nov 16 2026): her 297 drawn drawables in 166 draws
instead of 297, the same pixels; on the car (171 draws there) draw 5.7 ms
from 7.4, 20% of a frame.

The drawing's cost is the driver's work per draw call on the Atom, not
pixels: mask textures of 128 px instead of 256 changed nothing, and the
patched renderer, which sends the same pixels with far fewer GL calls, cut the
model's drawing in half. Cubism Core is now the biggest part; it scales with
the vertices, not the picture's size, so drawing smaller saves little
(estimated 1 to 2 ms at 75%).

**A smaller model beside it**: a chibi (a small, big-headed figure, a free
model), drawn on the car by the same test program, before the renderer patch
and with the 4:2:0 on the CPU, so against the first row above:

| | Chibi | RetrynowMiku |
| --- | --- | --- |
| Drawables | 668 | 484 |
| Vertices | 14,577 | 65,368 |
| Triangles | 19,430 | 96,230 |
| Parameters | 146 | 232 |
| Physics | 21 settings, 65 particles | 39 settings, 138 particles |
| Moc | 1.7 MB | 6.9 MB |
| Textures | 1 of 2048 px | 17 of 1024 px |
| Update (Core and physics) | 3.6 ms | 10.8 ms |
| Draw | 7.0 ms | 19.5 ms |
| Read + 4:2:0 | 1.8 + 3.3 ms | 1.9 + 3.6 ms |
| Of a 67 ms frame | 24% | 54% |

The update follows the vertices: 4.5 times the vertices took 3 times as
long. The draw doesn't follow the drawables: the chibi has more of them, yet
drew in a third of the time. What it lacks is RetrynowMiku's 59 clipping
masks and her 17 textures (a texture switch between many draws); with the
renderer patch both models would draw faster still, the chibi not measured so.

**The whole head unit** (`tools/car_usage.sh root@<car> 30`; Miku Live2D,
then Miku Bake with live2d-render idle, a few minutes apart):

| | Miku Live2D | Miku Bake |
| --- | --- | --- |
| live2d-render | 29.4% of a core, 41 MB, 2 threads | 0% (idle until it exits) |
| cluster-render | 4.2% (her video frames) | 1.9% |
| Custom HUD | 6.2%, 91 MB | 5.3%, 77 MB |
| GPU clock | 643 MHz average, 750 top | 100 MHz (idle) |
| Memory available | 1,937 of 5,644 MB | 1,922 of 5,644 MB |

So about a third of a core of CPU (8% of the unit), and the GPU, which BMW's
3D HMI shares, working near its top clock the whole time. Opening the model
took 15.4 s on the first run as a service (about 1 s for the test program),
to watch.

## The Cubism SDK

live2d-render as the Store installs it holds none of Live2D's code. Its drawing is in a small
library, the Cubism glue (`glue/`), built from your own copy of
[Cubism SDK for Native](https://www.live2d.com/en/sdk/download/native/) (5-r.5)
and copied to the head unit by hand; until it is there, live2d-render answers
every app with "no Cubism glue library". The glue holds Live2D's Framework,
with its OpenGL ES renderer patched for the head unit (`glue/apply_fast.py`:
one vertex upload a frame instead of one a draw, GL state sent only when it
changes, which halved the drawing on the unit's Atom, and drawables drawn one
after another with the same state sent as one draw), and Live2D's closed Core
beside it. Use of the SDK is under Live2D's own licence terms.

```sh
make glue SDK=~/Downloads/CubismSdkForNative-5-r.5     # build/sdk, in Docker
make deploy-sdk CAR=root@$CAR_IP                       # to /var/opt/live2d-render/sdk
```

For checking the patch: `CUBISM_STOCK=1` draws with Cubism's own renderer,
`CUBISM_NOBATCH=1` without batching, `CUBISM_NOCULL=1` without skipping what's
outside the picture, and `CUBISM_BATCH_CHECK=1` draws every frame both ways (every
drawable one at a time, and as the fast path does) and logs how many bytes differ
(0 expected). Every 10 s the glue logs where its drawing time goes.

Models live wherever the app says (an absolute path to the `.model3.json`, with
its moc, textures and physics beside it). Textures are loaded as they are, so
shrink big ones first: RetrynowMiku's 4096 px textures at 1024 px draw the
close-up just as well.

## Protocol

A Unix socket, `/dev/shm/live2d-render/render.sock` (group `tm_oap_app`; the
first app to connect starts the service, which exits a minute after the last
one goes). One flat JSON object a line each way. One app at a time: a new
connection replaces the last, whose model goes. Lists are strings.

App to live2d-render:

| `t` | Fields |
| --- | --- |
| `open` | `model` (absolute path), `w`, `h` (w a multiple of 4, h even), `frame` ("cx cy height": the box in model units, y up, that fills the picture), and optionally `fps` (15), `masks` (clipping-mask textures, 2; one holds 36 masks), `core` (1: Cubism Core on every frame; 2 to 4: on every core-th frame, the frames between it blended from the last two poses, a glue with `l2d_blend` needed; core - 1 frames later), `target` ("hud"), `x`, `y`, `z`, `class`, `visible`, `hide` ("PartA,PartB": parts drawn transparent), `v` (the first values, as `p`'s) |
| `p` | `v`: "Id=value Id=value ..." (space or comma separated); `reset` 1 sets every parameter back to its default first. Values not sent keep their last |
| `show`, `hide` | the layer shown or hidden; hidden, nothing is drawn |
| `move` | `x`, `y`, `z`: the layer, whole pixels |
| `offset` | `x`, `y`: the model moved inside its picture, in px (fractions too, at most a quarter of the picture each way); an app's own movement (Miku Live2D's bob). Since 0.1.1: 0.1.0 answers it with an `error` |
| `wind` | `g` (0 to 3, default 0): a wind group; `x`, `y`: its wind on her physics, x right and y up, against gravity's 1 down, at most 2 either way, kept until set again; `params` (once per model): the group's comma-separated parameters. Each group with parameters runs its own copy of the physics with its wind and keeps its values only for those, the rest keep the calm physics' (so her left hair can blow left, her right hair right, and her body's pendulums stay calm). Calm, with no groups, at each open. `ripple` (0 to 1) and `hz` (0.1.12, a glue with `l2d_set_wind_ripple`): a wave running down each of the group's physics chains from root to tip on top of the wind, `ripple` of each parameter's half range at the tip (half that at the root), each chain in its own phase, so a tail curls rather than swinging as one piece. Since 0.1.11, and only with a glue that has `l2d_set_wind` (`make glue`, `make deploy-sdk`): otherwise logged once and ignored. 0.1.10 and before answer it with an `error` |
| `close` | the model goes |

live2d-render to the app:

| `t` | Fields |
| --- | --- |
| `opened` | `params` (how many the model has), `defaults` (every parameter's default, "Id=value ..."), `ms` (loading), `gl`, and `unknown` / `missing_parts` for ids the model hasn't |
| `error` | `op`, `reason`: an `open` refused (the reason says why: no SDK, the crash guard, a model that won't load), or a message it couldn't read |
| `unknown` | `ids` a `p` named that the model hasn't (each once) |
| `layer` | `state`, `reason`: the video layer's, from cluster-render |
| `stats` | every 5 s while drawing: `fps`, `update`, `draw` (handing the frame to the GPU), `read` (collecting the last one) (ms a frame), `busy` (% of the frame's time, the CPU's) |

## Waiting for the KOMBI

On Nov 15 2026, at a car start with Miku Live2D already selected, the KOMBI
took her video layer, showed her for about 10 s, then froze on a still frame
and stopped answering the head unit: the link between them (`ipsec-kombi`)
went down and stayed down, the cluster showing its own gauges with no map until
the car slept. Picked a minute into a drive, she ran without trouble. The
KOMBI's display service answers well before it can take a steady video
stream, it seems.

So live2d-render sends no frames until the KOMBI's display service has been up
for 30 s (`--display-wait S`, 0 off). It asks cluster-render's status every
second while a model is open (its `dcsm: ... available for N s` line) and
counts the 30 s again whenever the display goes away, so a KOMBI restart
mid-drive is waited out too. The model opens meanwhile; at a car start she
shows about 30 s after the KOMBI comes up. With no display line in the status
(a bench's cluster-render) it doesn't wait; with no answer at all, it draws
after 10 s. Tried off the car against a fake display service that comes up and
goes away (Docker, Mesa's software renderer); not yet on the car.

## If the head unit restarted

A GPU fault in an earlier test program once restarted the whole head unit. So
while live2d-render draws it keeps `/var/opt/live2d-render/state/drawing`, and
removes it when it stops: the model closed, hidden, or the display gone (a car
switching off loses the KOMBI first, so parking leaves no file; until 0.1.9 the
file stayed the whole time a model was open, and a head unit powering off
without stopping live2d-render left it behind). Found after a restart, it means the unit went down
while it drew: live2d-render then refuses to draw (apps get the reason) until
you remove the file:

```sh
ssh root@$CAR_IP 'rm /var/opt/live2d-render/state/drawing'
```

(since 0.1.9 the refusal lifts at the next open once the file is gone, no
restart needed), or press **Restart Live2D Render** on Custom HUD's page: the
app sends `{"t":"restart"}`, which removes the file and the crash count and
ends live2d-render; systemd's socket starts it again at the app's next
connect, and Miku opens again by herself.

Found in the same boot it means live2d-render itself crashed; after 3 crashes
in one boot it refuses until the next.

## Building and trying

```sh
make test          # host tests: the control messages, the crash guard
make target        # build/target/live2d-render (Docker, Ubuntu 18.04 amd64)
make try MODEL=~/models/RetrynowMiku/RetrynowMiku.model3.json FRAME="0 1.31 0.82" \
         HIDE=Part49,Part50 PARAMS="Watermark=1"
```

`make try` (after `make glue`) runs it in Docker on Mesa's software renderer:
it opens the model through the socket as an app would, turns the head for six
seconds (or sends `SCRIPT=`'s messages, a JSON line a frame), checks every
frame's 4:2:0 against the CPU's byte for byte, and saves the frames to
`build/try/`.

For finding what draws wrong, the glue reads two switches from the
environment: `CUBISM_NO_PHYSICS=1` (the pose without physics) and
`CUBISM_MASK_SIZE=1024` (the clipping-mask textures' size, Cubism's 256).
Textures load without mipmaps: their smaller levels blended RetrynowMiku's
packed mouth shapes into one another at 1024 px (a "moustache").

`third_party/cluster_render/` is cluster-render 0.6.2's C++ client (MPL-2.0),
copied unchanged; copy it again when cluster-render's protocol changes.

## Releasing

The head unit builds apps but no native code, so the Store installs the binary
committed in `prebuilt/` (this repo's `mgu-repo.json` lists the tool, and
`component.json` names its files and systemd units). After changing the source:

```sh
make test
make prebuilt      # make target, copied to prebuilt/live2d-render
```

then raise `component.json`'s `"version"` and commit both; the Store offers
the new version from the next release tag of this repo.

To try a build on the car before releasing it, install it without the Store,
with mgu-store's deploy tool (a checkout of `mgu-store` beside this repo),
from the repo's root:

```sh
../mgu-store/deploy/hu artifact native/live2d-render --out dist
../mgu-store/deploy/hu install --host <car> --identity <root key> --artifact dist/live2d-render@<version>.tgz
```

The first packs `prebuilt/live2d-render`, the systemd units and
`component.json` as the Store would; the second installs it to
`/var/opt/live2d-render/current/` and enables its socket.
`deploy/hu uninstall live2d-render --yes` takes it off. The SDK and the
models aren't part of it: `make deploy-sdk`, and the app's own model copy.
