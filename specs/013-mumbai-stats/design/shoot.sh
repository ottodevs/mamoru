#!/usr/bin/env bash
# shoot.sh <page.html#hash> <w> <h> <out.png> — served from the repo root on :8737 (python3 -m http.server 8737).
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
src=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1")
win=$(( $2 < 600 ? 600 : $2 ))
tmp=$(mktemp --suffix=.png)
chromium --headless=new --disable-gpu --hide-scrollbars --window-size=$win,$(( $3 + 120 )) --virtual-time-budget=4000 \
  --screenshot="$tmp" "http://127.0.0.1:8737/specs/013-mumbai-stats/design/frame.html?src=$src&w=$2&h=$3" 2>/dev/null
magick "$tmp" -crop "${2}x${3}+0+0" +repage "$dir/$4"
rm -f "$tmp"
