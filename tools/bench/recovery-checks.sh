#!/usr/bin/env bash
# M6-05 kill -9 recovery checks (plan decision 10).
# Every stage launches the packaged binary under a pristine HOME taken from
# the deb produced by `npm run tauri build -- --bundles deb`, so the sweeps
# that run inside the real app's setup hook are what gets measured.
# Ticket resurrection is pinned by the unit test
# write::tests::tickets_never_resurrect_across_a_process_restart; the checks
# that cannot be driven headlessly are printed as the manual playbook tail.
# Usage: recovery-checks.sh <deb>
set -uo pipefail

deb="$(readlink -f "${1:?usage: recovery-checks.sh <deb>}")"
[ -f "$deb" ] || { echo "deb not found: $deb"; exit 1; }
work=/tmp/guit-m6-recovery
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
data="$home/config/dev.guit.desktop"

tools_dir="$(cd "$(dirname "$0")" && pwd)"
atspi_probe() { # atspi_probe <seconds> <regex> — exit 0 when the live tree matches
    /usr/bin/python3 - "$1" "$2" "$tools_dir" <<'PY' >>"$report" 2>&1
import sys
sys.path.insert(0, sys.argv[3])
import atspi_landmark

sys.exit(0 if atspi_landmark.wait_for(sys.argv[2], float(sys.argv[1])) else 1)
PY
}
not_atspi() { # not_atspi <regex> — the text must not be in the live tree
    ! atspi_probe 1 "$1"
}

launch_isolated() { # launch_isolated <logfile>
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
seed_session() { # seed_session <repo-path> — valid v1 session for restore tests
    mkdir -p "$data"
    printf '{"schema_version":1,"path":"%s"}\n' "$1" >"$data/session.json"
}

empty_state='Open a repository to list its working copy status\.'

say "== A: orphaned askpass bridge directories are swept at startup =="
mkdir -p "$home/run/guit-askpass-orphan-a" "$home/run/guit-askpass-orphan-b" "$home/run/keepme"
printf 'not a socket\n' >"$home/run/guit-askpass-orphan-b/pipe"
launch_isolated "$work/a.log"
if atspi_probe 15 "$empty_state"; then
    say "ok: app starts normally with orphans present"
else
    say "FAIL: empty state not reached"; fail=$((fail + 1))
fi
terminate_isolated
check "empty bridge directory swept" test ! -e "$home/run/guit-askpass-orphan-a"
check "bridge directory with a dead socket file swept" test ! -e "$home/run/guit-askpass-orphan-b"
check "unrelated runtime directory untouched" test -d "$home/run/keepme"
check "sweep count reported" grep -q "startup swept 2 stale askpass bridge" "$work/a.log"

say "== B: future-schema config is refused, files untouched, app still starts =="
mkdir -p "$data"
printf '{"schemaVersion":2,"width":3600,"height":2200,"x":5000,"y":5000,"alwaysOnTop":false}\n' >"$data/window.json"
printf '{"schema_version":2,"path":"/should/not/restore"}\n' >"$data/session.json"
printf '{"schema_version":2,"paths":["/should/not/restore"]}\n' >"$data/recent.json"
printf 'stale\n' >"$data/window.json.tmp123456"
touch -d '3 hours ago' "$data/window.json.tmp123456"
printf 'in flight\n' >"$data/session.json.tmpABCDEF"
for f in window.json session.json recent.json; do sha256sum "$data/$f" >"$work/$f.sha"; done
launch_isolated "$work/b.log"
if atspi_probe 15 "$empty_state"; then
    say "ok: refused session leaves the add-repository empty state"
else
    say "FAIL: app did not start cleanly on future-schema config"; fail=$((fail + 1))
fi
# showError overwrites: the last refusal wins the single alert element,
# so match the shared prefix rather than one message.
check "refusal is announced to the user" atspi_probe 2 'Unsupported'
check "refused session was not restored" not_atspi '/should/not/restore'
terminate_isolated
check "refused session and recent files left byte-identical" sha256sum -c --status \
    "$work/session.json.sha" "$work/recent.json.sha"
# window.json is refused on read (proven above) but guit's own autosave then
# persists a valid v1 — the refusal is about never guessing from foreign
# bytes, not about freezing the file forever.
check "window.json replaced only by guit's own valid v1 save" \
    grep -q '"schemaVersion":1' "$data/window.json"
check "stale config temp swept" test ! -e "$data/window.json.tmp123456"
check "fresh tempfile sibling kept (a live write may own it)" test -e "$data/session.json.tmpABCDEF"
check "config sweep reported" grep -q "1 stale config temp file" "$work/b.log"

say "== C: unreadable index surfaces the Git failure, never a clean report =="
# The alert element is single and last-error-wins, so each later stage
# starts from an empty config dir: stage B's refused recent.json would
# otherwise overwrite the index-failure alert.
rm -rf "$data"
repo_c="$work/c-repo"
mkdir -p "$repo_c"
git -C "$repo_c" init --quiet --initial-branch=main
git -C "$repo_c" -c user.email=t@example.invalid -c user.name=t commit --quiet --allow-empty -m base
printf 'work in progress\n' >"$repo_c/file.txt"
printf 'garbage' >"$repo_c/.git/index"
seed_session "$repo_c"
launch_isolated "$work/c.log"
# Git stderr follows the user's locale (host is zh_CN here), so match the
# locale-stable parts: guit passes the message through redacted-verbatim.
if atspi_probe 30 'fatal:.*\.git/index'; then
    say "ok: the failure is shown as an alert"
else
    say "FAIL: no index failure surfaced"; fail=$((fail + 1))
fi
check "a parse failure is never presented as a clean working copy" \
    not_atspi 'Working copy is clean\.'
terminate_isolated

say "== D: a leftover .git/index.lock is read through, never touched =="
repo_d="$work/d-repo"
mkdir -p "$repo_d"
git -C "$repo_d" init --quiet --initial-branch=main
git -C "$repo_d" -c user.email=t@example.invalid -c user.name=t commit --quiet --allow-empty -m base
printf 'dirty\n' >"$repo_d/tracked.txt"
# Shape left behind by a git process killed while it held the lock:
# the file is only reserved for its (now dead) owner.
printf '' >"$repo_d/.git/index.lock"
seed_session "$repo_d"
launch_isolated "$work/d.log"
if atspi_probe 30 'tracked\.txt'; then
    say "ok: read-only status worked through the stale lock and lists the change"
else
    say "FAIL: locked index did not render honestly"; fail=$((fail + 1))
fi
check "locked repository is not presented as clean" not_atspi 'Working copy is clean\.'
terminate_isolated
check "guit never deleted or wrote the user index.lock" \
    test "$(sha256sum "$repo_d/.git/index.lock" | cut -d' ' -f1)" = \
    "$(printf '' | sha256sum | cut -d' ' -f1)"

say "== playbook tail: steps that need a human =="
cat <<'TXT' | tee -a "$report"
manual 1 (interrupted fetch): start a fetch on a credential-protected HTTP
remote, answer the first prompt, then `kill -9` guit while a second prompt
is open. Restart: the startup sweep line must report and remove the
orphaned guit-askpass-* directory and the repository must show its real
state (fetch either applied or not) — never a stuck modal.
manual 2 (ticket resurrection): preview a branch delete, kill -9 guit
during the confirmation dialog, restart, and confirm the old dialog cannot
be re-confirmed (unit test: tickets_never_resurrect_across_a_process_restart).
manual 3 (multi-display clamp): with window.json restored from a two-screen
session, unplug the secondary display, restart guit and confirm the window
clamps back on screen (fit_window is unit-tested; this is the runtime check).
TXT

say "== verdict: fail=$fail =="
exit "$fail"
