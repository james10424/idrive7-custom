#!/usr/bin/env bash
# Push edited layouts to the car over SSH, without reinstalling the app.
#
#   ./scripts/deploy.sh root@<car-ip-or-hostname> [layout.json ...]
#   APP=custom_cluster ./scripts/deploy.sh root@<car> gt3.json      (the cluster app; default: Custom HUD)
#   ./scripts/deploy.sh root@<car> --miku <bake output folder>      (the Miku layout's baked frames)
#
# --miku copies the folder's atlas.json and atlas.etc2 (and close.etc2, the close-up, when the bake made one; ETC2 from
# tools/live2d_bake, which needs cluster-render 0.5.5 or later on the car) to the app's data folder,
# <app>/data/miku/. They stay out of this repo: the character's art belongs to its owner. The app picks them up the
# next time it builds the layout (switch to another layout and back, or restart the app).
#
# scripts/remove-miku.sh takes them off the car again.
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
    fi
fi
LAYOUT_DIR="$(dirname "$SCRIPT_DIR")/apps/${APP_ID}/hud/layouts"
if [ $# -eq 0 ] && [ -z "$MIKU_SRC" ]; then set -- "$LAYOUT_DIR"/*.json; fi

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
    ssh "$CAR_HOST" "rm -f '${APP_DIR}/data/${MIKU_DIR}/atlas.rgba' '${APP_DIR}/data/${MIKU_DIR}/close.rgba' '${APP_DIR}/data/${MIKU_DIR}/close.etc2'"
    scp "${MIKU_FILES[@]}" "${CAR_HOST}:${APP_DIR}/data/${MIKU_DIR}/"
    ssh "$CAR_HOST" "chown -R '${OWNER}' '${APP_DIR}/data/${MIKU_DIR}'"
    echo "Pushed the Miku frames to ${APP_DIR}/data/${MIKU_DIR}. Switch to another layout and back (or restart the app) to load them."
    exit 0
fi

# The data folder belongs to the app's own user: create layouts/ as that user's files.
OWNER="$(ssh "$CAR_HOST" "stat -c '%u:%g' '${APP_DIR}/data'")"
ssh "$CAR_HOST" "mkdir -p '${DEST}' && chown '${OWNER}' '${DEST}'"
scp "$@" "${CAR_HOST}:${DEST}/"
ssh "$CAR_HOST" "chown '${OWNER}' '${DEST}'/*.json"

echo "Pushed $# layout file(s) to ${DEST}. The app reloads them by itself; its status row on"
echo "the center screen says if a layout was refused and why."
