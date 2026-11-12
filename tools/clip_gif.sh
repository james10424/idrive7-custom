#!/bin/bash
# Turns the bench's captured frames (bench/.data/clips/<name>/0000.png ...) into docs/images/<name>.gif.
# usage: tools/clip_gif.sh <name> [fps 15] [width, default the frames' own] [crop w:h:x:y, before scaling]
set -euo pipefail
cd "$(dirname "$0")/.."
DEFAULT_FPS=15
PALETTE_COLORS=128   # the GIF palette's size
BAYER_SCALE=4        # the dither pattern's scale
name=$1 fps=${2:-$DEFAULT_FPS} width=${3:-} crop=${4:-}
src=bench/.data/clips/$name
[ -f "$src/0000.png" ] || { echo "no frames in $src"; exit 1; }
filters=""
[ -n "$crop" ] && filters="crop=$crop,"
[ -n "$width" ] && filters="${filters}scale=$width:-1:flags=lanczos,"
ffmpeg -v error -y -framerate "$fps" -i "$src/%04d.png" \
  -vf "${filters}split[a][b];[a]palettegen=max_colors=$PALETTE_COLORS:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=$BAYER_SCALE:diff_mode=rectangle" \
  -loop 0 "docs/images/$name.gif"
ls -l "docs/images/$name.gif"
