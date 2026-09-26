#!/usr/bin/env bash
# M6-06 diagnostics export click-through (plan decision 11).
# Launches the packaged deb under a pristine HOME and drives the whole
# export flow over AT-SPI: the About-row "Export diagnostics…" button, the
# content-manifest confirmation, the native save chooser (whose locale can
# be zh_CN, so the accept button is matched by label shape), and the
# resulting status line. Then asserts the file on disk is a valid export
# that never carries the home path or credential-shaped material.
# Usage: diagnostics-export-check.sh <deb>
set -uo pipefail

deb="$(readlink -f "${1:?usage: diagnostics-export-check.sh <deb>}")"
[ -f "$deb" ] || { echo "deb not found: $deb"; exit 1; }
work=/tmp/guit-m6-diagnostics
rm -rf "$work"; mkdir -p "$work"
report="$work/report.txt"
fail=0
say() { echo "$*" | tee -a "$report"; }
check() { # check <label> <command...>
    local label="$1"; shift
    if "$@" >>"$report" 2>&1; then say "ok: $label"; else say "FAIL: $label"; fail=$((fail + 1)); fi
}

root="$work/dpkg-x"; home="$work/home"
mkdir -p "$root" "$home/config" "$home/cache" "$home/run"
dpkg -x "$deb" "$root"
check "extracted binary is executable" test -x "$root/usr/bin/guit"

tools_dir="$(cd "$(dirname "$0")" && pwd)"
atspi_probe() { # atspi_probe <seconds> <regex> — exit 0 when the live tree matches
    /usr/bin/python3 - "$1" "$2" "$tools_dir" <<'PY' >>"$report" 2>&1
import sys
sys.path.insert(0, sys.argv[3])
import atspi_landmark

sys.exit(0 if atspi_landmark.wait_for(sys.argv[2], float(sys.argv[1])) else 1)
PY
}

export_driver() { # export_driver — click the full flow; exit code names the step
    /usr/bin/python3 - "$tools_dir" "$work" <<'PY' >>"$report" 2>&1
import os
import sys
import time

sys.path.insert(0, sys.argv[1])
import atspi_landmark

work = sys.argv[2]

def fail(step, message=""):
    with open(os.path.join(work, "driver.err"), "w") as handle:
        handle.write(f"step {step}: {message}\n")
    sys.exit(step)

# M7: the app opens on the Changes view; the export button lives in Settings,
# so switch to Settings first (the rail item is a button labelled "Settings").
if not atspi_landmark.wait_for(r"Changes", 20):
    fail(1, "app did not render its first view")
settings_tab = atspi_landmark.find_button(name="Settings")
if settings_tab is None or not atspi_landmark.click(settings_tab):
    fail(1, "cannot open the settings view")
if not atspi_landmark.wait_for(r"Export diagnostics", 20):
    fail(1, "export button not in tree")
trigger = atspi_landmark.find_button(name="Export diagnostics…")
if trigger is None or not atspi_landmark.click(trigger):
    fail(2, "cannot click export button")
if not atspi_landmark.wait_for(r"plain-text diagnostics report", 10):
    fail(3, "manifest confirmation not shown")
accept = atspi_landmark.find_button(name="Export…")
if accept is None or not atspi_landmark.click(accept):
    fail(4, "cannot click confirmation accept")

save_button = None
deadline = time.time() + 15
while time.time() < deadline and save_button is None:
    save_button = (
        atspi_landmark.find_button(contains="保存")
        or atspi_landmark.find_button(name="Save")
        or atspi_landmark.find_button(contains="Save")
    )
    if save_button is None:
        time.sleep(0.25)
if save_button is None:
    fail(5, "save chooser not drivable over AT-SPI")
if not atspi_landmark.click(save_button):
    fail(6, "cannot click chooser accept")
sys.exit(0)
PY
}

say "== export click-through on a pristine session =="
# The native chooser starts at the process working directory, so launch
# from a dedicated folder and expect the file there.
export_dir="$work/export"; mkdir -p "$export_dir"
export HOME="$home" XDG_CONFIG_HOME="$home/config" XDG_CACHE_HOME="$home/cache" XDG_RUNTIME_DIR="$home/run"
(cd "$export_dir" && exec "$root/usr/bin/guit" >"$work/app.log" 2>&1) &
launch_pid=$!
sleep 6
if ! atspi_probe 15 'Open a repository to list its working copy status\.'; then
    say "FAIL: app did not reach the empty state"; fail=$((fail + 1))
fi
export_driver
driver_status=$?
[ "$driver_status" -eq 0 ] || say "FAIL: export driver stopped at step $driver_status ($(cat "$work/driver.err" 2>/dev/null))"
[ "$driver_status" -eq 0 ] || fail=$((fail + 1))

exported=""
for _ in $(seq 1 20); do
    exported="$(find "$export_dir" -name 'guit-diagnostics*' -type f 2>/dev/null | head -1)"
    [ -n "$exported" ] && break
    sleep 0.5
done
check "diagnostics file was written under the isolated HOME" test -n "$exported"
if [ -n "$exported" ]; then
    check "file is a guit export" grep -q "^guit diagnostics export$" "$exported"
    check "file reports the platform pair" grep -q "^platform: linux" "$exported"
    check "file records a watch mode" grep -q "^watch_mode: " "$exported"
    check "file lists config files" grep -q "^config files (" "$exported"
    check "file carries the exclusion footer" grep -q "^excluded by design:" "$exported"
    check "home path is folded away" bash -c "! grep -q -- '$home' '$exported'"
    check "no credential-shaped line" bash -c "! grep -Eiq 'password|token=|secret' '$exported'"
    if atspi_probe 10 'Diagnostics written to'; then
        say "ok: UI confirmed the write"
    else
        say "FAIL: UI never showed the written-to status"; fail=$((fail + 1))
    fi
fi
kill -TERM "$launch_pid" 2>/dev/null
wait "$launch_pid" 2>/dev/null
unset HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR

say "== result: fail=$fail =="
exit "$fail"
