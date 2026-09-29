#!/usr/bin/env bash
# B-stage layout capture: launch the release binary against the UI fixture and
# grab its window. AT-SPI is unavailable on this host, so this is a static
# screenshot of the state the saved session opens into, not a driven journey.
#
#   b-shot.sh [repo] [name] [width] [height]
#
# The size arguments write the stored window geometry, so a layout can be
# photographed at a designed sample size (420x640, 340x400) instead of only at
# whatever the last human-sized window happened to be.
set -uo pipefail
BIN=/home/kys/code/guit/app/src-tauri/target/release/guit
REPO=${1:-/tmp/guit-ui-repo}
HOME_DIR=/tmp/guit-b01-home
OUT=/tmp/guit-shots
mkdir -p "$HOME_DIR/.config/dev.guit.desktop" "$HOME_DIR/.cache" "$HOME_DIR/runtime" "$OUT"
rm -rf "$HOME_DIR/.config/dev.guit.desktop/session.json"
printf '{"schema_version": 1, "path": "%s"}\n' "$REPO" > "$HOME_DIR/.config/dev.guit.desktop/session.json"
if [ -n "${3:-}" ] && [ -n "${4:-}" ]; then
  # The field names are camelCase, matching the Rust struct's serde rename.
  printf '{"schemaVersion":1,"width":%d,"height":%d,"x":80,"y":80,"alwaysOnTop":false}\n' "$3" "$4" \
    > "$HOME_DIR/.config/dev.guit.desktop/window.json"
else
  rm -f "$HOME_DIR/.config/dev.guit.desktop/window.json"
fi

env HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" XDG_CACHE_HOME="$HOME_DIR/.cache" \
  XDG_RUNTIME_DIR="$HOME_DIR/runtime" GDK_BACKEND=x11 DISPLAY="${DISPLAY:-:0}" \
  "$BIN" > "$HOME_DIR/app.log" 2>&1 &
PID=$!
# Wait for *this* process to map its own window. The reference is the set of
# guit windows that existed before the launch, so a window left over from an
# earlier run is never captured — and a fresh window that happens to reuse an
# X window id is, because that id was not in the set when we started.
BEFORE=$(xwininfo -root -tree | awk '/"guit"/ && !/mutter-x11-frames/ && !/20x20/ {print $1}')
WID=""
for _ in $(seq 1 40); do
  sleep 2
  for CAND in $(xwininfo -root -tree | awk '/"guit"/ && !/mutter-x11-frames/ && !/20x20/ {print $1}'); do
    if printf '%s\n' "$BEFORE" | grep -qxF "$CAND"; then continue; fi
    WID="$CAND"; break
  done
  [ -n "$WID" ] && break
done
if [ -z "$WID" ]; then echo "no guit window"; kill "$PID"; tail -20 "$HOME_DIR/app.log"; exit 1; fi
/home/kys/code/guit/tools/live/xgrab "$WID" "$OUT/$2.ppm"
ffmpeg -loglevel error -y -i "$OUT/$2.ppm" "$OUT/$2.png"
echo "shot: $OUT/$2.png wid=$WID"
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
echo "app exit=$?"
