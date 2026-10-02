#!/usr/bin/env python3
"""Live screenshot pass for guit on this machine.

Drives the running app over AT-SPI (the only input channel that works under
XWayland here — XTest warps and XSendEvent are silently dropped by mutter)
and captures each state with xgrab (XGetImage on the app window works even
though root-window capture is black).

Usage:
  python3 tools/live/live-screens.py <path-to-guit-binary> [repo]

Needs: /usr/bin/python3 with gi/Atspi, an X display (:0), and the xgrab
binary next to this script (cc -O2 -o xgrab xgrab.c -lX11).

Writes PNGs to /tmp/guit-shots and prints one line per shot. A shot whose
page never loads aborts with a message instead of capturing the wrong page.
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bench"))
import atspi_landmark as A  # noqa: E402

BIN = sys.argv[1] if len(sys.argv) > 1 else "/tmp/guit-verify/app/src-tauri/target/release/guit"
REPO = sys.argv[2] if len(sys.argv) > 2 else "/tmp/guit-ui-repo"
HOME = "/tmp/guit-live-home"
OUT = "/tmp/guit-shots"
XGRAB = os.path.join(HERE, "xgrab")

os.makedirs(OUT, exist_ok=True)
subprocess.run(["rm", "-rf", HOME], check=True)
for sub in (".config/dev.guit.desktop", ".cache", "runtime"):
    os.makedirs(os.path.join(HOME, sub), exist_ok=True)
# A saved session makes the app open REPO directly, with no native dialogs.
with open(os.path.join(HOME, ".config/dev.guit.desktop/session.json"), "w") as h:
    h.write('{"schema_version": 1, "path": "%s"}\n' % REPO)
env = dict(os.environ, HOME=HOME, XDG_CONFIG_HOME=HOME + "/.config",
           XDG_CACHE_HOME=HOME + "/.cache", XDG_RUNTIME_DIR=HOME + "/runtime",
           GDK_BACKEND="x11", DISPLAY=os.environ.get("DISPLAY", ":0"))
log = open(os.path.join(HOME, "app.log"), "w")
proc = subprocess.Popen([BIN], env=env, stdout=log, stderr=log, start_new_session=True)


def shot(name):
    out = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True,
                         env=env).stdout
    wid = next((l.strip().split()[0] for l in out.splitlines()
                if '"guit"' in l and "mutter-x11-frames" not in l and "20x20" not in l), None)
    if not wid:
        raise RuntimeError("no guit window for " + name)
    subprocess.run([XGRAB, wid, f"{OUT}/{name}.ppm"], check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"{OUT}/{name}.ppm",
                    f"{OUT}/{name}.png"], check=True)
    print("shot:", name, flush=True)


def named(text, exact=False):
    for n in A.tree(A.app_root()):
        nm = A._once(lambda: n.get_name(), default="") or ""
        if (nm == text) if exact else text in nm:
            return n
    return None


def open_page(page, ready_regex):
    item = A.find_button(name=page)
    assert item and A.click(item), f"cannot open {page}"
    assert A.wait_for(ready_regex, 15), f"{page} page never loaded"
    time.sleep(0.5)


def graph_rows():
    """The commit rows, told apart from the file rows by their reading shape.

    Both lists are on the one page now, and both are LIST_ITEMs, so the row that
    names an author and a date is the graph's; a file row is named for its path.
    """
    return [n for n in A.tree(A.app_root())
            if (A._once(lambda: n.get_role().value_name, default="") or "") == "ATSPI_ROLE_LIST_ITEM"
            and " — " in (A._once(lambda: n.get_name(), default="") or "")]


A.Atspi.init()
try:
    assert A.wait_for(r"Commit message", 60), "app did not reach the panel"
    time.sleep(1.0)
    # The one page, both regions in the frame: this shot is the evidence that the
    # changes area and the graph are visible together, which no text assertion
    # can make.
    shot("01-main")

    for page, fname, ready in [
        ("Settings", "02-settings", r"Interface zoom|Theme"),
        ("Main", "03-main", r"Commit message"),
    ]:
        open_page(page, ready)
        shot(fname)

    # The branch picker: a layer over Main. AT-SPI cannot tell a covering layer
    # from the page under it, so the picture is the check.
    assert A.click(A.find_button(name="Repository menu")), "no repository menu"
    time.sleep(0.3)
    chip = A.find_menu_item("Branches and tags")
    assert chip and A.click(chip), "no branch management entry"
    assert A.wait_for(r"Filter branches and tags", 15), "the picker never opened"
    time.sleep(0.5)
    shot("04-branch-picker")
    open_page("Settings", r"Interface zoom")
    open_page("Main", r"Commit message")
    time.sleep(0.5)

    # history detail: activate the first commit row
    rows = graph_rows()
    if rows:
        A._once(lambda: rows[0].do_action(0))
        time.sleep(0.8)
    shot("05-commit-selected")

    # discard preview must come from a tracked-modified row; an untracked
    # row's menu only offers Open/Diff and has no Discard
    more = named("More actions for mod3.py")
    if not more:
        more = next((n for n in A.tree(A.app_root())
                     if (A._once(lambda: n.get_name(), default="") or "")
                     .startswith("More actions for ")), None)
    assert more and A.click(more), "no row menu"
    time.sleep(0.6)
    shot("06-row-menu")
    disc = named("Discard", exact=True)
    if disc:
        A.click(disc)
        assert A.wait_for(r"Keep changes", 8), "discard modal never opened"
        time.sleep(0.5)
        shot("07-discard-preview")
        keep = named("Keep changes", exact=True)
        if keep:
            A.click(keep)
            time.sleep(0.5)

    # zoom extremes
    open_page("Settings", r"Interface zoom")
    zin = named("Zoom in", exact=True) or named("+", exact=True)
    for _ in range(3):
        if zin:
            A.click(zin)
            time.sleep(0.4)
    shot("08-settings-zoomed")

    # dark theme: the select must stay legible (WebKitGTK used to paint it
    # with the system theme, giving light text on a light box)
    combo = named("Follow system") or named("Dark")
    if combo:
        A.click(combo)
        time.sleep(0.5)
        dark = named("Dark", exact=True)
        if dark:
            A.click(dark)
            time.sleep(0.8)
            shot("09-dark-theme")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
