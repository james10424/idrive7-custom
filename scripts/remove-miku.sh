#!/usr/bin/env bash
# Remove baked Miku frames from the car over SSH (what deploy.sh --miku pushed, or an older --miku-fb).
# Your bake folders on this computer are left alone.
#
#   ./scripts/remove-miku.sh root@<car> --miku-fb               (Custom HUD's data/miku-fb/, the forward/back lean)
#   ./scripts/remove-miku.sh root@<car> --miku                  (Custom HUD's data/miku/, the Miku layout's frames)
#   ./scripts/remove-miku.sh root@<car> --miku --miku-fb -y     (several at once; -y skips the question)
#
# Each folder is looked for in its app's data folder (/var/opt/public/oap/oap_<uid>/data/, the app found by its
# source/package.json, as deploy.sh does); one that isn't there is skipped. The app notices on its next layout build
# (switch layouts or restart it): with miku/ gone the Miku layout says it has no baked frames.
set -euo pipefail

OAP_ROOT="/var/opt/public/oap"

usage() {
    echo "Usage: $(basename "$0") <car-ssh-host> --miku | --miku-fb [...] [-y]" >&2
    exit 1
}

[ $# -ge 2 ] || usage
CAR_HOST="$1"; shift

YES=""
TARGETS=()
for a in "$@"; do
    case "$a" in
        --miku|--miku-fb) TARGETS+=("custom_hud:${a#--}") ;;
        -y) YES=1 ;;
        *) usage ;;
    esac
done
[ ${#TARGETS[@]} -ge 1 ] || usage

# find each folder on the car first, then ask once
FOUND=()
for t in "${TARGETS[@]}"; do
    app="${t%%:*}"; dir="${t#*:}"
    app_dir="$(ssh "$CAR_HOST" "grep -l '\"name\": \"${app}\"' ${OAP_ROOT}/oap_*/source/package.json 2>/dev/null | head -1 | sed 's#/source/package.json##'")"
    if [ -z "$app_dir" ]; then echo "${app} isn't installed on ${CAR_HOST}: skipping ${dir}/"; continue; fi
    if ssh "$CAR_HOST" "[ -d '${app_dir}/data/${dir}' ]"; then
        FOUND+=("${app_dir}/data/${dir}")
    else
        echo "No ${dir}/ in ${app}'s data folder: nothing to remove"
    fi
done
[ ${#FOUND[@]} -ge 1 ] || exit 0

echo "On ${CAR_HOST}, this removes:"
printf '  %s\n' "${FOUND[@]}"
if [ -z "$YES" ]; then
    read -r -p "Remove them? [y/N] " ok
    [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "Nothing removed."; exit 0; }
fi
for d in "${FOUND[@]}"; do
    ssh "$CAR_HOST" "rm -rf '${d}'"
    echo "Removed ${d}"
done
echo "Switch layouts or restart the app for it to notice."
