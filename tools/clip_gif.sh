#!/bin/bash
# Turns the bench's captured frames (bench/.data/clips/<name>/0000.png ...) into docs/images/<name>.gif.
# usage: tools/clip_gif.sh <name> [fps 15] [width, default the frames' own] [crop w:h:x:y, before scaling]
set -euo pipefail
cd "$(dirname "$0")/.."
name=$1 fps=${2:-15} width=${3:-} crop=${4:-}
src=bench/.data/clips/$name
[ -f "$src/0000.png" ] || { echo "no frames in $src"; exit 1; }
filters=""
[ -n "$crop" ] && filters="crop=$crop,"
[ -n "$width" ] && filters="${filters}scale=$width:-1:flags=lanczos,"
ffmpeg -v error -y -framerate "$fps" -i "$src/%04d.png" \
  -vf "${filters}split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "docs/images/$name.gif"
ls -l "docs/images/$name.gif"
