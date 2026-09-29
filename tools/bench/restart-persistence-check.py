#!/usr/bin/python3
"""Restart persistence: the second launch reads back what the first one wrote.

The stage-G exit gate asks that the settings survive a restart. Until now the
evidence for that was a Node test that hands a pure model an object shaped like
storage: it proves the merge and the refusal rules, and it proves nothing about
a webview that flushes on its own schedule, a close path that writes geometry
before it destroys the window, or a start that reads a record back and applies
it rather than defaulting. This run does that part, in one isolated HOME and two
launches of the same release binary.

What it drives is what AT-SPI can act on. A `<select>` picks an option through a
menu item, a button answers `do_action`, and that is how the scheme and the
interface size get set here. The three font boxes, the age-line interval and the
custom-theme fragment are all typed controls, and this host has no channel that
writes one: WebKitGTK exposes no EditableText interface on an entry (the probe
that looked asked for it on the path of a real `<input>` and was refused), and
there is no key-injection tool in reach of a Wayland session. Those three stay a
manual gate, and the docstring says so rather than letting a green run imply
they were covered.

The two sessions are compared to each other and never to a number. Extents are
logical pixels and the sizes the app asks for are not the same unit, so the
width a window comes up with is only ever checked against the width the previous
window had when it closed. The node read is the window's frame, because the web
document's own box is its scrollable content rather than the window it is drawn
in — measured on one 720-wide window, the frame and the webview's scroll pane
both read 720 while the document read 736.

The launch then runs twice more from a geometry file this build cannot read — one
of garbage bytes, one of a record whose schema version is newer than the code.
Both have a unit test that refuses them inside a temporary directory; what only a
window can answer is that the refusal is survivable: the panel still comes up, at
the size the build ships rather than a size read out of unreadable bytes, with the
appearance record the person actually chose still in force. The newer-version run
also checks its own bytes afterwards, because the seal has to hold against the
save the window makes 400ms after start and not merely against a read.

Usage: restart-persistence-check.py <release-binary> <fixture-repo> <work-dir> [--keep]
Prints one line per assertion; exits non-zero when any assertion fails.
"""

import argparse
import glob
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_landmark as A  # noqa: E402

# The size the panel draws with before anything is chosen. The run needs its
# opposite number, because "18px" on screen is only evidence of a read-back if
# 16px was never on screen to begin with.
ZOOM_DEFAULT_PX = 16
ZOOM_DEFAULT = f"{ZOOM_DEFAULT_PX}px"

# Two geometry files the shipped build must refuse, and refuse in a way the panel
# survives. The second is deliberately a size no window has in this run: read as
# geometry it would show up in the measured width, which is how a refusal that
# silently fell back to parsing is caught.
BAD_GEOMETRY = "guit wrote this and then the disk went wrong\n"
FUTURE_GEOMETRY = json.dumps(
    {"schemaVersion": 2, "width": 500, "height": 500, "x": 0, "y": 0, "alwaysOnTop": False}
) + "\n"


class Report:
    def __init__(self):
        self.fails = []

    def check(self, label, ok, detail=""):
        print(("ok:   " if ok else "FAIL: ") + label + (f"  [{detail}]" if detail else ""), flush=True)
        if not ok:
            self.fails.append(label)


def prepare(work, repo):
    for sub in (".config/dev.guit.desktop", ".cache", "runtime"):
        os.makedirs(os.path.join(work, sub), exist_ok=True)
    with open(os.path.join(work, ".config/dev.guit.desktop/session.json"), "w", encoding="utf-8") as handle:
        handle.write('{"schema_version": 1, "path": "%s"}\n' % os.path.abspath(repo))


def environment(work):
    return dict(os.environ, HOME=work, XDG_CONFIG_HOME=os.path.join(work, ".config"),
                XDG_CACHE_HOME=os.path.join(work, ".cache"), XDG_RUNTIME_DIR=os.path.join(work, "runtime"))


def launch(binary, work, log_name):
    """Start the panel and hand back the process plus the log it is writing to.

    Each session gets its own log file: the two runs' startup lines are separate
    evidence, and a reader comparing them should not have to find the seam.
    """
    handle = open(os.path.join(work, log_name), "w", encoding="utf-8")
    process = subprocess.Popen([binary], env=environment(work), stdout=handle, stderr=handle,
                               start_new_session=True)
    return process, handle


def terminate(process, handle):
    try:
        os.killpg(os.getpgid(process.pid), 15)
    except (OSError, ProcessLookupError):
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(process.pid), 9)
    handle.close()


def read_record(work):
    """The versioned appearance record, and the storage keys beside it.

    Copied, not opened: the live database's write-ahead log holds the newest
    values and opening the originals would checkpoint it into the app's own file.
    """
    source = os.path.join(work, ".local/share/dev.guit.desktop/localstorage")
    scratch = os.path.join(work, ".record-scratch")
    subprocess.run(["rm", "-rf", scratch], check=True)
    os.makedirs(scratch, exist_ok=True)
    for path in glob.glob(os.path.join(source, "tauri_localhost_0.localstorage*")):
        shutil.copy(path, scratch)
    database = os.path.join(scratch, "tauri_localhost_0.localstorage")
    if not os.path.exists(database):
        return None, []
    connection = sqlite3.connect(database)
    try:
        rows = {
            key: (value.decode("utf-16-le", "replace") if isinstance(value, bytes) else value)
            for key, value in connection.execute("select key, value from ItemTable")
        }
    except sqlite3.Error:
        return None, []
    finally:
        connection.close()
    raw = rows.get("guit.preferences")
    if raw is None:
        return None, sorted(rows)
    try:
        return json.loads(raw), sorted(rows)
    except ValueError:
        return None, sorted(rows)


def await_record(work, wanted, deadline_s=6.0):
    """Poll the record until it matches, or run out of time and say what it held."""
    deadline = time.time() + deadline_s
    while True:
        record, keys = read_record(work)
        if wanted(record):
            return record, keys
        if time.time() >= deadline:
            return record, keys
        time.sleep(0.5)


def window_width():
    """The window's own screen width, polled through a relayout.

    The frame and not the document: `ATSPI_ROLE_DOCUMENT_WEB` reports the
    *scrollable content* box, which is a fact about the page rather than the
    window. Measured on one 720-wide window, the frame read 720, the webview's
    scroll pane 720 and the document 736 — a size claim taken from that last
    number is a claim about whatever the page happens to need, and it moved by
    16 px on its own when the interface size went up.
    """
    for _ in range(20):
        for node in A.tree(A.app_root()):
            if (A._once(lambda: node.get_role().value_name, default="") or "") != "ATSPI_ROLE_FRAME":
                continue
            if (A._once(lambda: node.get_name(), default="") or "") != "guit":
                continue
            extent = A._once(lambda: node.get_component().get_extents(A.Atspi.CoordType.SCREEN), default=None)
            if extent is not None and extent.width > 0:
                return extent.width
        time.sleep(0.25)
    return None


def settings_page():
    A.click(A.find_button(name="Settings"))
    time.sleep(1.0)


def pick_theme(label, report):
    """Open the Theme select and choose one option by name."""
    combo = None
    for node in A.tree(A.app_root()):
        if (A._once(lambda: node.get_name(), default="") or "") == "Theme" and (
                A._once(lambda: node.get_role().value_name, default="") or "") == "ATSPI_ROLE_COMBO_BOX":
            combo = node
    if combo is None:
        report.check("the Theme select is reachable", False)
        return
    A.click(combo)
    time.sleep(0.6)
    item = None
    for node in A.tree(A.app_root()):
        if (A._once(lambda: node.get_role().value_name, default="") or "") == "ATSPI_ROLE_MENU_ITEM" and (
                A._once(lambda: node.get_name(), default="") or "") == label:
            item = node
            break
    report.check(f"option \u201c{label}\u201d can be picked", item is not None and A.click(item))


def geometry_path(work):
    return os.path.join(work, ".config/dev.guit.desktop/window.json")


def seed_geometry(work, text):
    """Put bytes where the next launch will look for its geometry.

    The harness seeds this file the way it seeds `session.json`: it is a config
    file the panel owns and rewrites, so writing one is not forging a format the
    app keeps internally.
    """
    with open(geometry_path(work), "w", encoding="utf-8") as handle:
        handle.write(text)


def read_geometry(work):
    try:
        with open(geometry_path(work), encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


def bad_geometry_run(binary, work, report, label, seed, wanted_size, default_width):
    """One launch that starts from a geometry file this build cannot use.

    Returns whatever the file holds once the window is gone, so the caller can
    say whether the refusal also held against the save the window makes on its
    own schedule.
    """
    seed_geometry(work, seed)
    process, handle = launch(binary, work, f"{label}.log")
    try:
        reached = A.wait_for(r"Commit message", 30) is not None
        report.check(f"a refused {label} geometry file still leaves a panel on screen", reached)
        if reached:
            # Measured before anything else is clicked: this is the width the build
            # ships with, and a file that got parsed anyway would show its own here.
            width = window_width()
            report.check(f"the {label} window comes up at the shipped size, not the refused one",
                         width == default_width, f"measured={width!r} shipped={default_width!r}")
            settings_page()
            text = A.dump()
            report.check(f"the {label} session is a working panel, not a half-drawn shell",
                         A.find_button(name="Settings") is not None
                         and A.find_button(name="Close guit") is not None)
            report.check(f"the {label} session draws the size the record holds",
                         wanted_size is not None and f"{wanted_size}px" in text and ZOOM_DEFAULT not in text,
                         f"wanted={wanted_size!r} default={ZOOM_DEFAULT} present={ZOOM_DEFAULT in text}")
            record, keys = read_record(work)
            report.check(f"a refused {label} geometry file does not cost the appearance record",
                         (record or {}).get("theme") == "dark"
                         and (record or {}).get("fontPx") == wanted_size,
                         f"record={record!r} keys={keys}")
    finally:
        terminate(process, handle)
    return read_geometry(work)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("repo")
    parser.add_argument("work")
    parser.add_argument("--keep", action="store_true", help="keep the isolated HOME")
    args = parser.parse_args()
    work = args.work
    subprocess.run(["rm", "-rf", work], check=True)
    prepare(work, args.repo)
    report = Report()

    process, handle = launch(args.binary, work, "session-1.log")
    closed_width = None
    default_width = None
    wanted_size = None
    try:
        A.Atspi.init()
        report.check("the first session reaches the panel", A.wait_for(r"Commit message", 30) is not None)
        # The shipped size, taken before this run touches any window control, so it is
        # the size the build ships with rather than one this run asked for. The
        # refused-geometry launches below are compared to this rather than to a literal,
        # because a document extent and the sizes the app asks for are not the same unit
        # on every desktop.
        time.sleep(1.0)
        default_width = window_width()
        report.check("the first session comes up at a measurable size", default_width is not None,
                     f"shipped={default_width!r}")
        settings_page()
        zoom = A.find_button(name="Zoom in")
        report.check("the zoom buttons are reachable", zoom is not None)
        if zoom is not None:
            # Two steps, so the size on screen is neither the default nor one off it.
            A.click(zoom)
            A.click(zoom)
            time.sleep(1.0)
            pick_theme("Dark", report)
            time.sleep(1.0)
            compact = A.find_button(name="Test compact window")
            report.check("the compact-window test is reachable", compact is not None)
            if compact is not None:
                A.click(compact)
                time.sleep(1.5)
                closed_width = window_width()

        # Written down before anything closes: if the second session comes up at the
        # default, this line says whether the value ever reached storage at all.
        record, keys = await_record(work, lambda value: (value or {}).get("theme") == "dark")
        wanted_size = (record or {}).get("fontPx")
        report.check("the first session stores the scheme the select chose",
                     (record or {}).get("theme") == "dark", f"keys={keys}")
        report.check("the first session stores a size the zoom button moved",
                     isinstance(wanted_size, int) and wanted_size != ZOOM_DEFAULT_PX,
                     f"stored={wanted_size!r}")

        quit_button = A.find_button(name="Close guit")
        report.check("the window's own close control is reachable", quit_button is not None)
        if quit_button is not None:
            A.click(quit_button)
            try:
                code = process.wait(timeout=20)
                report.check("the close control ends the process", code is not None, f"exit={code!r}")
            except subprocess.TimeoutExpired:
                report.check("the close control ends the process", False, "still running after 20s")
        handle.close()
        handle = None

        # The record is read again with no process holding it, because a value that
        # only the running webview can see has not survived anything.
        record, keys = read_record(work)
        report.check("the record is on disk once the window is gone",
                     (record or {}).get("theme") == "dark" and (record or {}).get("fontPx") == wanted_size,
                     f"record={record!r} keys={keys}")
    finally:
        if handle is not None:
            terminate(process, handle)
        else:
            terminate(process, open(os.devnull, "w", encoding="utf-8"))

    # --- the second launch, same HOME ---
    process, handle = launch(args.binary, work, "session-2.log")
    try:
        report.check("the second session reaches the panel", A.wait_for(r"Commit message", 30) is not None)
        reopened_width = window_width()
        report.check("the second window comes back the size the close wrote down",
                     closed_width is not None and reopened_width == closed_width,
                     f"closed={closed_width!r} reopened={reopened_width!r}")
        settings_page()
        text = A.dump()
        report.check("the second session shows the size the first one set",
                     wanted_size is not None and f"{wanted_size}px" in text,
                     f"wanted={wanted_size!r}")
        report.check("the second session is not drawing the default size",
                     ZOOM_DEFAULT not in text,
                     f"default={ZOOM_DEFAULT} present={ZOOM_DEFAULT in text} wanted={wanted_size!r}")
        # A start that cannot read the record defaults it, and the defaults are the
        # one thing a restart is not supposed to bring back.
        record, keys = read_record(work)
        report.check("the second session reads the scheme back rather than defaulting it",
                     (record or {}).get("theme") == "dark", f"stored={(record or {}).get('theme')!r}")
        report.check("the second session keeps every field the record holds",
                     record is not None and record.get("fontPx") == wanted_size
                     and "schemaVersion" in record,
                     f"record={record!r}")
        report.check("the pre-versioned names stay gone",
                     "guit.theme" not in keys and "guit.fontPx" not in keys, f"keys={keys}")
    finally:
        terminate(process, handle)

    # --- the same HOME, started from a geometry file it cannot read ---
    unreadable = bad_geometry_run(args.binary, work, report, "unreadable", BAD_GEOMETRY,
                                  wanted_size, default_width)
    report.check("a geometry file the build cannot read is not kept as a promise",
                 unreadable is not None and unreadable != BAD_GEOMETRY,
                 f"holds={None if unreadable is None else unreadable.strip()!r}")

    future = bad_geometry_run(args.binary, work, report, "newer-version", FUTURE_GEOMETRY,
                              wanted_size, default_width)
    # The refusal has to outlive the window's own save, or a newer file is read-only
    # for as long as nobody resizes.
    report.check("a geometry file written by a newer version survives the session",
                 future == FUTURE_GEOMETRY,
                 f"holds={None if future is None else future.strip()!r}")

    if not args.keep:
        subprocess.run(["rm", "-rf", work], check=False)

    print(f"\nfails={len(report.fails)}: {report.fails}")
    return 1 if report.fails else 0


if __name__ == "__main__":
    sys.exit(main())
