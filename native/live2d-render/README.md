# Live2D Render

Draws a Live2D model live on the head unit's GPU for an app, and shows it as a
[cluster-render](https://github.com/robertnisipeanu/idrive-apps) video layer (the HUD by default).
The app sends the model's parameter values as often as it likes; live2d-render
draws at the frame rate the app asked for, with the model's physics (hair,
clothes) on top. It knows nothing about any particular model: what the model
does is the app's (Custom HUD's "Miku Live2D" layout, for one).

iDrive 7 only. It is the one process here that drives the GPU itself, at CPU
priority 19, so BMW's HMI always comes first. On a 2020 G20's head unit
(Intel HD 505, Mesa 19), RetrynowMiku's 248x280 close-up at 15 fps takes about
39% of each frame's time: Cubism's Core ~10.5 ms, drawing ~12.8 ms, the 4:2:0
~1.9 ms.

## The Cubism SDK

live2d-render as the Store installs it holds none of Live2D's code. Its drawing is in a small
library, the Cubism glue (`glue/`), built from your own copy of
[Cubism SDK for Native](https://www.live2d.com/en/sdk/download/native/) (5-r.5)
and copied to the head unit by hand; until it is there, live2d-render answers
every app with "no Cubism glue library". The glue holds Live2D's Framework,
with its OpenGL ES renderer patched for the head unit (`glue/apply_fast.py`:
one vertex upload a frame instead of one a draw, and GL state sent only when it
changes, which halved the drawing on the unit's Atom), and Live2D's closed Core
beside it. Use of the SDK is under Live2D's own licence terms.

```sh
make glue SDK=~/Downloads/CubismSdkForNative-5-r.5     # build/sdk, in Docker
make deploy-sdk CAR=root@$CAR_IP                       # to /var/opt/live2d-render/sdk
```

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
| `open` | `model` (absolute path), `w`, `h` (w a multiple of 4, h even), `frame` ("cx cy height": the box in model units, y up, that fills the picture), and optionally `fps` (15), `masks` (clipping-mask textures, 2; one holds 36 masks), `target` ("hud"), `x`, `y`, `z`, `class`, `visible`, `hide` ("PartA,PartB": parts drawn transparent), `v` (the first values, as `p`'s) |
| `p` | `v`: "Id=value Id=value ..." (space or comma separated); `reset` 1 sets every parameter back to its default first. Values not sent keep their last |
| `show`, `hide` | the layer shown or hidden; hidden, nothing is drawn |
| `move` | `x`, `y`, `z` |
| `close` | the model goes |

live2d-render to the app:

| `t` | Fields |
| --- | --- |
| `opened` | `params` (how many the model has), `defaults` (every parameter's default, "Id=value ..."), `ms` (loading), `gl`, and `unknown` / `missing_parts` for ids the model hasn't |
| `error` | `op`, `reason`: an `open` refused (the reason says why: no SDK, the crash guard, a model that won't load), or a message it couldn't read |
| `unknown` | `ids` a `p` named that the model hasn't (each once) |
| `layer` | `state`, `reason`: the video layer's, from cluster-render |
| `stats` | every 5 s while drawing: `fps`, `update`, `draw`, `read` (ms a frame), `busy` (% of the frame's time) |

## If the head unit restarted

A GPU fault in an earlier test program once restarted the whole head unit. So
while live2d-render draws it keeps `/var/opt/live2d-render/state/drawing`, and
removes it when it stops. Found after a restart, it means the unit went down
while it drew: live2d-render then refuses to draw (apps get the reason) until
you remove the file:

```sh
ssh root@$CAR_IP 'rm /var/opt/live2d-render/state/drawing'
```

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
