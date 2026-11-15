#!/usr/bin/env bash
# Push edited layouts to the car over SSH, without reinstalling the app.
#
#   ./scripts/deploy.sh root@<car-ip-or-hostname> [layout.json ...]
#   APP=custom_cluster ./scripts/deploy.sh root@<car> gt3.json      (the cluster app; default: Custom HUD)
#   ./scripts/deploy.sh root@<car> --miku <bake output folder>      (the Miku layout's baked frames)
#   ./scripts/deploy.sh root@<car> --miku-live <model.model3.json>  (Miku Live2D's model)
#   ./scripts/deploy.sh root@<car> --miku-live-config <bake config.json> <model.model3.json>   (trying poses)
#
# --miku copies the folder's atlas.json and atlas.etc2 (and close.etc2, the close-up, when the bake made one, with a
# close-up-only bake's idle.etc2 (and idle2.etc2, its odd frames, past 40) and lean.etc2; ETC2 from
# tools/live2d_bake, which needs cluster-render 0.5.9 or later on the car) to the app's data folder,
# <app>/data/miku/. They stay out of this repo: the character's art belongs to its owner. The app picks them up the
# next time it builds the layout (switch to another layout and back, or restart the app).
#
# scripts/remove-miku.sh takes them off the car again.
#
# --miku-live is for the Miku Live2D layout, drawn live by live2d-render (native/live2d-render, with its Cubism SDK
# copied to the car by hand: its README.md). It copies the model (its moc, physics and textures, the textures shrunk
# to 1024 px with sips) to /var/opt/live2d-render/models/<model name>/, where the layout's "model" points: once, as
# her poses come with the app (hud/miku-live/). The model never goes in this repo.
#
# --miku-live-config tries other poses without a new app: it copies a close-up bake config and the expression files
# it names (found next to the model) to <app>/data/miku-live/, which the layout then reads in place of the app's
# pose file. Delete that folder on the car to go back to the app's.
#
# With no files it pushes the app's built-in layouts from apps/<app>/hud/layouts/.
# They land in the app's data folder, <app>/data/layouts/, where a file overrides the
# built-in layout of the same name (layouts.js). The running app watches that folder and
# redraws the HUD by itself. Delete a file there to go back to the built-in layout.
#
# The app's folder is found on the car, not assumed: OAP installs each app under
# /var/opt/public/oap/oap_<uid>/, and its source/package.json names the app.
# UNVERIFIED until the first install: that path pattern (it comes from
# cauliflowermossgrape/idrive7-apps' docs) and SSH access as root.
set -euo pipefail

APP_ID="${APP:-custom_hud}"
OAP_ROOT="/var/opt/public/oap"

usage() {
    echo "Usage: $(basename "$0") <car-ssh-host> [layout.json ...]" >&2
    echo "  e.g.: $(basename "$0") root@10.0.0.42 my-sport.json" >&2
    exit 1
}

[ $# -ge 1 ] || usage
CAR_HOST="$1"; shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIKU_SRC=""
MIKU_DIR="miku"
if [ "${1:-}" = "--miku" ]; then
    MIKU_DIR="${1#--}"
    [ $# -eq 2 ] && [ -d "$2" ] || { echo "Usage: $(basename "$0") <car-ssh-host> $1 <bake output folder>" >&2; exit 1; }
    MIKU_SRC="$2"; shift 2
    [ -f "$MIKU_SRC/atlas.json" ] && [ -f "$MIKU_SRC/atlas.etc2" ] || { echo "No atlas.json and atlas.etc2 in $MIKU_SRC (bake again with the current tools/live2d_bake)" >&2; exit 1; }
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$MIKU_SRC/atlas.json" || { echo "Not valid JSON: $MIKU_SRC/atlas.json" >&2; exit 1; }
    # the close-up she zooms into when the car stops: its own atlas, when the bake made one
    MIKU_FILES=("$MIKU_SRC/atlas.json" "$MIKU_SRC/atlas.etc2")
    if python3 -c 'import json,sys; sys.exit(0 if "close" in json.load(open(sys.argv[1])) else 1)' "$MIKU_SRC/atlas.json"; then
        [ -f "$MIKU_SRC/close.etc2" ] || { echo "atlas.json has a close-up but $MIKU_SRC/close.etc2 is missing" >&2; exit 1; }
        MIKU_FILES+=("$MIKU_SRC/close.etc2")
        # a close-up-only bake's idle loop: its own atlas
        if python3 -c 'import json,sys; sys.exit(0 if "idle" in json.load(open(sys.argv[1])).get("close", {}) else 1)' "$MIKU_SRC/atlas.json"; then
            [ -f "$MIKU_SRC/idle.etc2" ] || { echo "atlas.json has an idle loop but $MIKU_SRC/idle.etc2 is missing" >&2; exit 1; }
            MIKU_FILES+=("$MIKU_SRC/idle.etc2")
            # over 40 frames, the odd ones in a second atlas
            if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["close"]["idle"].get("split") else 1)' "$MIKU_SRC/atlas.json"; then
                [ -f "$MIKU_SRC/idle2.etc2" ] || { echo "atlas.json splits the idle loop but $MIKU_SRC/idle2.etc2 is missing" >&2; exit 1; }
                MIKU_FILES+=("$MIKU_SRC/idle2.etc2")
            fi
        fi
        # and its lean: its own atlas
        if python3 -c 'import json,sys; sys.exit(0 if "leanAtlas" in json.load(open(sys.argv[1])).get("close", {}) else 1)' "$MIKU_SRC/atlas.json"; then
            [ -f "$MIKU_SRC/lean.etc2" ] || { echo "atlas.json has a lean atlas but $MIKU_SRC/lean.etc2 is missing" >&2; exit 1; }
            MIKU_FILES+=("$MIKU_SRC/lean.etc2")
        fi
    fi
fi
LIVE_MODE=""
if [ "${1:-}" = "--miku-live-config" ]; then
    [ $# -eq 3 ] && [ -f "$2" ] && [ -f "$3" ] || { echo "Usage: $(basename "$0") <car-ssh-host> --miku-live-config <bake config.json> <model.model3.json>" >&2; exit 1; }
    LIVE_MODE="config"; LIVE_CFG="$2"; LIVE_MODEL="$3"; shift 3
    python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); sys.exit(0 if "close" in c else 1)' "$LIVE_CFG" || { echo "$LIVE_CFG: not a bake config with a close-up (close)" >&2; exit 1; }
    MODEL_DIR="$(cd "$(dirname "$LIVE_MODEL")" && pwd)"
    LIVE_TMP="$(mktemp -d)"; trap 'rm -rf "$LIVE_TMP"' EXIT
    cp "$LIVE_CFG" "$LIVE_TMP/config.json"
    # the expressions the config names, from next to the model
    python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["close"].get("expressions", [])))' "$LIVE_CFG" | while IFS= read -r e; do
        [ -n "$e" ] || continue
        [ -f "$MODEL_DIR/$e" ] || { echo "the config names $e, not next to the model in $MODEL_DIR" >&2; exit 1; }
        cp "$MODEL_DIR/$e" "$LIVE_TMP/"
    done
fi
if [ "${1:-}" = "--miku-live" ]; then
    [ $# -eq 2 ] && [ -f "$2" ] || { echo "Usage: $(basename "$0") <car-ssh-host> --miku-live <model.model3.json>" >&2; exit 1; }
    LIVE_MODE="model"; LIVE_MODEL="$2"; shift 2
    MODEL_NAME="$(basename "$LIVE_MODEL" .model3.json)"
    LIVE_TMP="$(mktemp -d)"; trap 'rm -rf "$LIVE_TMP"' EXIT
    # the model: model3.json, moc, physics and textures as it names them, the textures shrunk to 1024 px
    python3 - "$LIVE_MODEL" "$LIVE_TMP" <<'PY'
import json, os, shutil, subprocess, sys
src, out = sys.argv[1], sys.argv[2]
d = os.path.dirname(os.path.abspath(src))
m = json.load(open(src))
refs = m["FileReferences"]
files = [refs["Moc"]] + ([refs["Physics"]] if refs.get("Physics") else [])
for f in files:
    os.makedirs(os.path.join(out, os.path.dirname(f)), exist_ok=True)
    shutil.copy(os.path.join(d, f), os.path.join(out, f))
for t in refs.get("Textures", []):
    os.makedirs(os.path.join(out, os.path.dirname(t)), exist_ok=True)
    subprocess.run(["sips", "-Z", "1024", os.path.join(d, t), "--out", os.path.join(out, t)], check=True, stdout=subprocess.DEVNULL)
keep = {"Moc", "Textures", "Physics"}
m["FileReferences"] = {k: v for k, v in refs.items() if k in keep}
json.dump(m, open(os.path.join(out, os.path.basename(src)), "w"), indent=1)
print("model: %d textures shrunk to 1024 px" % len(refs.get("Textures", [])))
PY
    # live2d-render's folder, not the app's: no app to look for
    ssh "$CAR_HOST" "mkdir -p '/var/opt/live2d-render/models/${MODEL_NAME}'"
    scp -r "$LIVE_TMP"/* "${CAR_HOST}:/var/opt/live2d-render/models/${MODEL_NAME}/"
    echo "Pushed the model to /var/opt/live2d-render/models/${MODEL_NAME}. Pick Miku Live2D (or another layout and back) to load it."
    exit 0
fi
LAYOUT_DIR="$(dirname "$SCRIPT_DIR")/apps/${APP_ID}/hud/layouts"
if [ $# -eq 0 ] && [ -z "$MIKU_SRC" ] && [ -z "$LIVE_MODE" ]; then set -- "$LAYOUT_DIR"/*.json; fi

# Check each file locally first: valid JSON, so the car never gets a file it would refuse.
for f in "$@"; do
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" || { echo "Not valid JSON: $f" >&2; exit 1; }
done

APP_DIR="$(ssh "$CAR_HOST" "grep -l '\"name\": \"${APP_ID}\"' ${OAP_ROOT}/oap_*/source/package.json 2>/dev/null | head -1 | sed 's#/source/package.json##'")"
if [ -z "$APP_DIR" ]; then
    echo "Could not find ${APP_ID} under ${OAP_ROOT} on ${CAR_HOST}. Is the app installed?" >&2
    exit 1
fi
DEST="${APP_DIR}/data/layouts"
echo "App folder on the car: ${APP_DIR}"

if [ -n "$MIKU_SRC" ]; then
    OWNER="$(ssh "$CAR_HOST" "stat -c '%u:%g' '${APP_DIR}/data'")"
    ssh "$CAR_HOST" "mkdir -p '${APP_DIR}/data/${MIKU_DIR}'"
    # the RGBA files of older bakes (the app reads only the ETC2 ones now) and any old close-up
    ssh "$CAR_HOST" "rm -f '${APP_DIR}/data/${MIKU_DIR}/atlas.rgba' '${APP_DIR}/data/${MIKU_DIR}/close.rgba' '${APP_DIR}/data/${MIKU_DIR}/close.etc2' '${APP_DIR}/data/${MIKU_DIR}/idle.etc2' '${APP_DIR}/data/${MIKU_DIR}/idle2.etc2' '${APP_DIR}/data/${MIKU_DIR}/lean.etc2'"
    scp "${MIKU_FILES[@]}" "${CAR_HOST}:${APP_DIR}/data/${MIKU_DIR}/"
    ssh "$CAR_HOST" "chown -R '${OWNER}' '${APP_DIR}/data/${MIKU_DIR}'"
    echo "Pushed the Miku frames to ${APP_DIR}/data/${MIKU_DIR}. Switch to another layout and back (or restart the app) to load them."
    exit 0
fi

if [ "$LIVE_MODE" = "config" ]; then
    OWNER="$(ssh "$CAR_HOST" "stat -c '%u:%g' '${APP_DIR}/data'")"
    ssh "$CAR_HOST" "mkdir -p '${APP_DIR}/data/miku-live'"
    scp "$LIVE_TMP"/* "${CAR_HOST}:${APP_DIR}/data/miku-live/"
    ssh "$CAR_HOST" "chown -R '${OWNER}' '${APP_DIR}/data/miku-live'"
    echo "Pushed the bake config to ${APP_DIR}/data/miku-live: Miku Live2D reads it in place of the app's poses."
    echo "Switch to another layout and back to load it; delete that folder to go back to the app's poses."
    exit 0
fi

# The data folder belongs to the app's own user: create layouts/ as that user's files.
OWNER="$(ssh "$CAR_HOST" "stat -c '%u:%g' '${APP_DIR}/data'")"
ssh "$CAR_HOST" "mkdir -p '${DEST}' && chown '${OWNER}' '${DEST}'"
scp "$@" "${CAR_HOST}:${DEST}/"
ssh "$CAR_HOST" "chown '${OWNER}' '${DEST}'/*.json"

echo "Pushed $# layout file(s) to ${DEST}. The app reloads them by itself; its status row on"
echo "the center screen says if a layout was refused and why."
