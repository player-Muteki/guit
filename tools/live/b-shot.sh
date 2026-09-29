#!/usr/bin/env bash
# B-stage layout capture: launch the release binary against the UI fixture and
# grab its window. AT-SPI is unavailable on this host, so this is a static
# screenshot of the state the saved session opens into, not a driven journey.
set -uo pipefail
BIN=/home/kys/code/guit/app/src-tauri/target/release/guit
REPO=${1:-/tmp/guit-ui-repo}
HOME_DIR=/tmp/guit-b01-home
OUT=/tmp/guit-shots
mkdir -p "$HOME_DIR/.config/dev.guit.desktop" "$HOME_DIR/.cache" "$HOME_DIR/runtime" "$OUT"
rm -rf "$HOME_DIR/.config/dev.guit.desktop/session.json"
printf '{"schema_version": 1, "path": "%s"}\n' "$REPO" > "$HOME_DIR/.config/dev.guit.desktop/session.json"
env HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" XDG_CACHE_HOME="$HOME_DIR/.cache" \
  XDG_RUNTIME_DIR="$HOME_DIR/runtime" GDK_BACKEND=x11 DISPLAY="${DISPLAY:-:0}" \
  "$BIN" > "$HOME_DIR/app.log" 2>&1 &
PID=$!
# Wait for *this* process to map its own window: a leftover window from an
# earlier run has a different id, and capturing that one shows the old build.
WID=""
for _ in $(seq 1 40); do
  sleep 2
  CAND=$(xwininfo -root -tree | awk '/"guit"/ && !/mutter-x11-frames/ && !/20x20/ {print $1; exit}')
  if [ -n "$CAND" ] && [ "$CAND" != "$(cat /tmp/guit-b01-last-wid 2>/dev/null)" ]; then WID="$CAND"; break; fi
done
echo "$WID" > /tmp/guit-b01-last-wid
if [ -z "$WID" ]; then echo "no guit window"; kill "$PID"; tail -20 "$HOME_DIR/app.log"; exit 1; fi
/home/kys/code/guit/tools/live/xgrab "$WID" "$OUT/$2.ppm"
ffmpeg -loglevel error -y -i "$OUT/$2.ppm" "$OUT/$2.png"
echo "shot: $OUT/$2.png wid=$WID"
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
echo "app exit=$?"
