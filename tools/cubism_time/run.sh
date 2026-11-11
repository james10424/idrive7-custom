#!/usr/bin/env bash
# Times Cubism Core posing a Live2D model on the car's head unit (time.js), as a mesh-layer Live2D would every frame.
#
#   tools/cubism_time/run.sh <car-ssh-host> <model folder or .moc3> [frames=300] [--fps=15] [--pose=all|hud|still]
#
# --fps paces the frames as an app's tick (default: back to back); --pose picks what moves (time.js POSES).
#
# CUBISM_CORE names live2dcubismcore.js (default: the newest ~/Downloads/CubismSdkForWeb-*/Core/). Copies Core, the
# .moc3 and time.js to a temporary folder on the car, runs them with the car's Node, prints the report and deletes
# the folder. Changes nothing else. Neither Core nor the model goes in this repo: Core is Live2D's, the model its
# owner's.
set -euo pipefail

CAR="${1:?usage: $(basename "$0") <car-ssh-host> <model folder or .moc3> [frames]}"
MODEL="${2:?usage: $(basename "$0") <car-ssh-host> <model folder or .moc3> [frames]}"
shift 2
ARGS="${*:-300}"
HERE="$(cd "$(dirname "$0")" && pwd)"

CORE="${CUBISM_CORE:-$(ls -d "$HOME"/Downloads/CubismSdkForWeb-*/Core/live2dcubismcore.js 2>/dev/null | tail -1)}"
[ -f "$CORE" ] || { echo "no live2dcubismcore.js: set CUBISM_CORE" >&2; exit 1; }
if [ -d "$MODEL" ]; then
    MOC="$(find "$MODEL" -maxdepth 2 -name '*.moc3' | head -1)"
else
    MOC="$MODEL"
fi
[ -f "${MOC:-}" ] || { echo "no .moc3 in $MODEL" >&2; exit 1; }

DIR=/tmp/cubism_time
echo "Core: $CORE"
echo "model: $MOC"
ssh "$CAR" "rm -rf $DIR && mkdir -p $DIR"
scp -q "$CORE" "$CAR:$DIR/core.js"
scp -q "$MOC" "$CAR:$DIR/model.moc3"
scp -q "$HERE/time.js" "$CAR:$DIR/time.js"
# the car's Node: on the PATH, else the first node binary under the usual places
ssh "$CAR" "NODE=\$(command -v node || find /usr /opt /var/opt -maxdepth 6 -name node -type f -perm -u+x 2>/dev/null | head -1);
    [ -n \"\$NODE\" ] || { echo 'no node on the car'; rm -rf $DIR; exit 1; };
    echo \"node: \$NODE\"; cd $DIR && \"\$NODE\" time.js core.js model.moc3 $ARGS; status=\$?; rm -rf $DIR; exit \$status"
