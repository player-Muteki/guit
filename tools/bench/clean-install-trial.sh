#!/usr/bin/env bash
# M6-04 clean-environment install trial (plan decision 8, four stages).
# Stage 1 inspects package metadata, stage 2 runs the unpacked binary under a
# pristine HOME and asserts it writes only inside the user data directory,
# stage 3 really installs and purges (sudo, authorized 2026-09-25) and checks
# the design decision that ~/.config/dev.guit.desktop survives purge, and
# stage 4 unpacks the rpm if the tools exist (recorded honestly if not).
# Usage: clean-install-trial.sh <deb> <rpm> [fixture-repo]
set -uo pipefail

deb="${1:?usage: clean-install-trial.sh <deb> <rpm> [fixture-repo]}"
rpm="${2:?missing rpm path}"
repo="${3:-/tmp/guit-m6-bench/1k}"
# Root runs from its own cwd under sudo/pkexec — everything must be absolute.
deb="$(readlink -f "$deb")"
rpm="$(readlink -f "$rpm")"
repo="$(readlink -f "$repo")"
work=/tmp/guit-m6-install
rm -rf "$work"; mkdir -p "$work"
report="$work/report.txt"
fail=0
real_home="$HOME"   # stage 3 markers live in the login user's config, not the trial HOME
say() { echo "$*" | tee -a "$report"; }
check() { # check <label> <command...>
    local label="$1"; shift
    if "$@" >>"$report" 2>&1; then say "ok: $label"; else say "FAIL: $label"; fail=$((fail + 1)); fi
}

say "== stage 1: package metadata =="
dpkg -I "$deb" >"$work/dpkg-I.txt" 2>&1
for field in "Package: guit" "Maintainer: player-Muteki" "Section: devel" "Description:" "Homepage" ; do
    if grep -q "$field" "$work/dpkg-I.txt"; then
        say "ok: control contains '$field'"
    else
        # Description multiline and an absent Homepage are both fine shapes;
        # only the metadata the plan promises is asserted strictly.
        case "$field" in
        "Homepage" | "Description:") say "note: control lacks '$field'" ;;
        *) say "FAIL: control lacks '$field'"; fail=$((fail + 1)) ;;
        esac
    fi
done
dpkg -c "$deb" >"$work/dpkg-c.txt" 2>&1
check "deb ships usr/bin/guit" grep -q "usr/bin/guit$" "$work/dpkg-c.txt"
check "deb ships a desktop entry" grep -q "\.desktop$" "$work/dpkg-c.txt"
check "deb ships hicolor icons" grep -q "icons/hicolor/.*/apps/guit\.png" "$work/dpkg-c.txt"

say "== stage 2: unpacked binary under a pristine HOME =="
root="$work/dpkg-x"; home="$work/home"
mkdir -p "$root" "$home/config" "$home/cache" "$home/run"
dpkg -x "$deb" "$root"
check "extracted binary is executable" test -x "$root/usr/bin/guit"

tools_dir="$(cd "$(dirname "$0")" && pwd)"
atspi_expect() { # atspi_expect <seconds> <literal text> — probe the live AT tree
    /usr/bin/python3 - "$@" "$tools_dir" <<'PY' >>"$report" 2>&1
import re, sys
sys.path.insert(0, sys.argv[3])
import atspi_landmark

found = atspi_landmark.wait_for(re.escape(sys.argv[2]), float(sys.argv[1]))
sys.exit(0 if found else 1)
PY
}

launch_isolated() { # launch isolated — background the unpacked binary
    export HOME="$home" XDG_CONFIG_HOME="$home/config" XDG_CACHE_HOME="$home/cache" XDG_RUNTIME_DIR="$home/run"
    "$root/usr/bin/guit" >"$1" 2>&1 &
    launch_pid=$!
    sleep 6
}

terminate_isolated() {
    kill -TERM "$launch_pid" 2>/dev/null
    wait "$launch_pid" 2>/dev/null
    unset HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR
}

launch_isolated "$work/gui.log"
if atspi_expect 15 "Open a repository to list its working copy status."; then
    say "ok: first run renders the add-repository empty state"
else
    say "FAIL: empty state not visible on first run"; fail=$((fail + 1))
fi
terminate_isolated
# Seed a session and assert restore against the live tree.
mkdir -p "$home/config/dev.guit.desktop"
printf '{"schema_version":1,"path":"%s"}\n' "$repo" >"$home/config/dev.guit.desktop/session.json"
launch_isolated "$work/gui-seeded.log"
if atspi_expect 30 "Changes"; then
    say "ok: seeded session restores (Changes view present)"
else
    say "FAIL: seeded session restore not visible"; fail=$((fail + 1))
fi
terminate_isolated
# Zero writes outside the user's own data areas: guit's config dir, plus the
# WebKit data dir the runtime creates under the identifier (measured: local
# storage, CacheStorage salt, hsts sqlite, WebKitCache, mediakeys). Anything
# else in $home is a stray write.
outside=$(find "$home" -type f \
    -not -path "$home/config/dev.guit.desktop/*" \
    -not -path "$home/.local/share/dev.guit.desktop/*" | grep -v '^$' || true)
if [ -z "$outside" ]; then say "ok: no writes outside the user data directory"; else say "FAIL: stray writes: $outside"; fail=$((fail + 1)); fi
say "user data files after trial: $(find "$home/config/dev.guit.desktop" -type f -printf '%f ' 2>/dev/null)"
unset HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR

say "== stage 3: real install and purge (privileged) =="
user_config="$real_home/.config/dev.guit.desktop"
mkdir -p "$user_config"
marker="$user_config/m6-install-trial.marker"
echo "survives-purge" >"$marker"
# Privilege path: a fresh sudo ticket if present, else pkexec (polkit agent
# dialog, authorized by the user for this trial 2026-09-25).
if sudo -n true 2>/dev/null; then
    priv=("sudo" "-n")
elif command -v pkexec >/dev/null 2>&1; then
    priv=("pkexec")
else
    priv=()
fi
if [ ${#priv[@]} -eq 0 ]; then
    say "FAIL: no privilege path (no sudo token, no pkexec) — rerun stage 3"
    fail=$((fail + 1))
else
    check "dpkg -i installs guit" "${priv[@]}" dpkg -i "$deb"
    check "which finds /usr/bin/guit" test "$(which guit 2>/dev/null)" = "/usr/bin/guit"
    check "system desktop entry installed" test -s /usr/share/applications/guit.desktop
    check "system icon installed" test -s /usr/share/icons/hicolor/128x128/apps/guit.png
    check "dpkg --purge removes guit" "${priv[@]}" dpkg --purge guit
    if [ -f "$marker" ]; then say "ok: $user_config survived purge (by design)"; else say "FAIL: user data directory was purged"; fail=$((fail + 1)); fi
    rm -f "$marker"
    check "dpkg no longer knows guit" bash -c "! dpkg -s guit 2>/dev/null | grep -q 'Status: install ok installed'"
fi

say "== stage 4: rpm payload =="
if command -v rpm2cpio >/dev/null 2>&1 && command -v cpio >/dev/null 2>&1; then
    rpmdir="$work/rpm-x"; mkdir -p "$rpmdir"
    if (cd "$rpmdir" && rpm2cpio "$rpm" | cpio -id --quiet); then
        check "rpm ships usr/bin/guit" test -f "$rpmdir/usr/bin/guit"
        check "rpm ships a desktop entry" bash -c "ls $rpmdir/usr/share/applications/*.desktop >/dev/null"
    else
        say "FAIL: rpm2cpio extraction failed"; fail=$((fail + 1))
    fi
    if command -v rpm >/dev/null 2>&1; then
        rpm -qp --requires "$rpm" >"$work/rpm-requires.txt" 2>&1 && say "ok: rpm -qp --requires recorded"
    else
        say "note: 'rpm' not installed; dependency view limited to the bundler log"
    fi
else
    say "note: rpm2cpio/cpio not installed on this host; rpm payload verified only by the bundler's own output (recorded honestly)"
fi

say "== verdict: fail=$fail =="
exit "$fail"
