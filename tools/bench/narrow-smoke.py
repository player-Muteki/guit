#!/usr/bin/python3
"""Narrow-window smoke over AT-SPI.

Drives Settings → Developer "Test compact window", which resizes the window to
the project's declared 340x400 minimum, and asserts the shell's primary actions
are still reachable at that size, then that the restore gives the window its own
box back. The window cluster — pin, minimise, maximise or restore, close — is
asked for on both pages at both sizes, since the promise is that every page this
panel shows has them. Overflow is layout-check.py's job; this suite is about
reachability at the minimum size and about the resize round-trip.

The last thing it does is press the app bar's own close, because that is the one
route the window ever leaves by and nothing else here exercises it: the app must
end by itself, and the geometry it writes on the way out must be the box the
window had at that moment — the restored one, not the minimum it was shrunk to.
That is a claim about a file the app owns, so it is sampled twice through the
same channel and the two samples are compared to each other rather than to a
number (see `geometry`).

Four channels, and the assertion has to use the one that can see its subject:
- `showing_names()` carries *controls* — tab items, buttons, inputs. A plain
  label span has no accessible name at all, so Settings' "Interface zoom" text
  is invisible here and can never be a landmark;
- `A.dump()` carries that label text, which is where page landmarks come from;
- the document's extents carry geometry, in physical pixels while the app sizes
  are logical ones, so the round-trip is compared against its own wide box
  rather than against a number;
- and `SHOWING` carries *this scroll position*, which is not reachability. A page
  taller than the minimum window legitimately holds controls that are not showing,
  so a row inside a scrolling page is asserted through `reach()` — focus it, and it
  must come on screen — while the app bar and status bar, which are pinned, are
  asserted by name directly.

Usage: /usr/bin/python3 narrow-smoke.py <release-binary> <fixture-repo> <work-dir>
Needs python3-gi and a live AT-SPI bus; the release binary comes from
`npm run bin:release`.
"""

import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_landmark as A  # noqa: E402

# The two pages, by the name the tab item carries. At the minimum width the
# strip shows its glyph only, and the name is the accessible label rather than
# the word, so the same two names have to be present at both sizes.
TABS = {"Main", "Settings"}
APPBAR = {"Open repository", "Refresh status", "Close session", "Commit",
          "Always on top", "More repository actions",
          "Minimise", "Maximise window", "Close guit"}
# The four the outline promises at the corner of every window this panel can be
# shrunk to. Asked for on both pages rather than once per run: the app bar belongs
# to the shell instead of to a page, and that is only a fact about the source until
# something presses the tab and asks again.
WINDOW_CLUSTER = {"Always on top", "Minimise", "Maximise window", "Close guit"}
# At the minimum width the app bar drops its Commit button, because the changes
# area already carries a commit box in the same place. The affordance has to
# survive, not both copies of it, so it is checked where it lives instead.
# The three session icons go the same way at this width: the More menu repeats
# all three by the same words, and two of them have a shortcut. What may not go
# is the window cluster — the outline promises those four actions at the corner
# of every window this panel can be shrunk to, and no other control on the bar
# carries them.
APPBAR_NARROW = APPBAR - {"Commit", "Open repository", "Refresh status", "Close session"}
ZOOM = {"Zoom in", "Zoom out", "Reset zoom"}


def saved_bounds(work):
    """What the application last wrote its own box down as, in its own units.

    The geometry file carries physical pixels while the sizes this suite asks the
    window for are logical ones, so it is never compared to a number here — only
    to another reading of the same file, which is the same unit by construction.
    """
    path = os.path.join(work, ".config", "dev.guit.desktop", "window.json")
    for _ in range(20):
        try:
            with open(path, encoding="utf-8") as handle:
                saved = json.load(handle)
            if isinstance(saved.get("width"), int) and isinstance(saved.get("height"), int):
                return saved
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    return None


class Report:
    def __init__(self):
        self.fails = []

    def check(self, label, ok, detail=""):
        print(("ok:   " if ok else "FAIL: ") + label + (f"  [{detail}]" if detail else ""), flush=True)
        if not ok:
            self.fails.append(label)


def showing_names():
    names = set()
    for node in A.tree(A.app_root()):
        states = A._once(lambda: [s.value_name for s in node.get_state_set().get_states()], default=[]) or []
        if "ATSPI_STATE_SHOWING" in states:
            name = A._once(lambda: node.get_name(), default="") or ""
            if name:
                names.add(name)
    return names


def reach(name):
    """Whether the control named can actually be got to, by focus if need be.

    SHOWING is a statement about the current scroll position, not about the
    control: a Settings page taller than a 400px window is allowed to keep a row
    below the fold, and a row above it is off screen too. So an off-screen node
    here is asked for focus — the engine scrolls whatever takes focus into view,
    which is precisely what a keyboard user gets — and the state is read after.
    Two failures stay failures: a name that is not in the tree at all, and a node
    that takes focus and still does not show.

    This is only ever used for page content. The app bar and the status bar are
    pinned, so for them SHOWING is honest and the ordinary name-set applies.
    """
    node = A.find_button(name=name)
    if node is None:
        return "absent from the tree"
    states = A._once(lambda: [s.value_name for s in node.get_state_set().get_states()], default=[]) or []
    if "ATSPI_STATE_SHOWING" in states:
        return "on screen"
    if "ATSPI_STATE_FOCUSABLE" not in states:
        return "off screen and cannot take focus"
    A._once(lambda: node.grab_focus(), default=False)
    time.sleep(0.8)
    after = A._once(lambda: [s.value_name for s in node.get_state_set().get_states()], default=[]) or []
    return "reached by focus" if "ATSPI_STATE_SHOWING" in after else "took focus and stayed off screen"


def document_rect(refuse_width=None):
    """The webview document's own screen box, polled through a relayout.

    This is the channel that answers "how big is the window" — names carry
    controls, not geometry. Only the *width* is a window fact: the document node
    reports its scrollable content height (a 400x760 window reports h=867), so
    the height here says what the page needs, not what the frame got. A document
    that has just switched views reports a zero extent, so poll rather than read
    once. Extents and the sizes the app asks for are not the same unit (a seeded
    `window.json` width of 800 measured 400), so the round-trip is compared
    against the same window's own box, never against a number.

    A reading is only accepted once the same width has come back twice in a row,
    because a window that has just been resized keeps answering with the box of
    the state it is leaving until the compositor catches up: one measured run read
    340 back immediately after a restore that had already happened and reported it
    as a failed restore. A caller that knows which of the two widths is the one
    being left behind says so with `refuse_width`, and gets that box back anyway if
    the window never did leave it — a stuck window is a fact, not a missing reading.
    """
    previous = None
    refused = None
    for _ in range(40):
        current = None
        for node in A.tree(A.app_root()):
            if (A._once(lambda: node.get_role().value_name, default="") or "") != "ATSPI_ROLE_DOCUMENT_WEB":
                continue
            extent = A._once(lambda: node.get_component().get_extents(A.Atspi.CoordType.SCREEN), default=None)
            if extent is not None and extent.width > 0 and extent.height > 0:
                current = extent.width, extent.height
                break
        if current is not None and current[0] == previous:
            if refuse_width is None or current[0] != refuse_width:
                return current
            refused = current
        previous = current[0] if current is not None else None
        time.sleep(0.25)
    return refused


def main():
    binary, repo, work = sys.argv[1], sys.argv[2], sys.argv[3]
    subprocess.run(["rm", "-rf", work], check=True)
    for sub in (".config/dev.guit.desktop", ".cache", "runtime"):
        os.makedirs(os.path.join(work, sub), exist_ok=True)
    with open(os.path.join(work, ".config/dev.guit.desktop/session.json"), "w", encoding="utf-8") as handle:
        handle.write('{"schema_version": 1, "path": "%s"}\n' % os.path.abspath(repo))
    env = dict(os.environ, HOME=work, XDG_CONFIG_HOME=os.path.join(work, ".config"),
               XDG_CACHE_HOME=os.path.join(work, ".cache"), XDG_RUNTIME_DIR=os.path.join(work, "runtime"))
    log = open(os.path.join(work, "app.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([binary], env=env, stdout=log, stderr=log, start_new_session=True)
    report = Report()
    try:
        A.Atspi.init()
        if A.wait_for(r"Commit message", 30) is None:
            report.check("the app reaches the panel", False, "no commit box in the tree")
            print("FAIL: the app never reached the panel")
            return 1
        wide = showing_names()
        report.check("the app bar's primary actions are visible when wide", APPBAR <= wide,
                     ",".join(sorted(APPBAR - wide)))
        report.check("both pages are reachable when wide", TABS <= wide,
                     ",".join(sorted(TABS - wide)))

        A.click(A.find_button(name="Main"))
        time.sleep(1.0)
        main_wide = showing_names()
        report.check("Main carries the window cluster when wide", WINDOW_CLUSTER <= main_wide,
                     ",".join(sorted(WINDOW_CLUSTER - main_wide)))

        # --- shrink to the declared minimum, 340x400 ---
        wide_rect = document_rect()
        A.click(A.find_button(name="Settings"))
        time.sleep(1.0)
        settings_wide = showing_names()
        report.check("Settings carries the same window cluster", WINDOW_CLUSTER <= settings_wide,
                     ",".join(sorted(WINDOW_CLUSTER - settings_wide)))
        A.click(A.find_button(name="Test compact window"))
        time.sleep(2.5)
        compact_rect = document_rect(refuse_width=wide_rect[0] if wide_rect else None)
        # Sampled while the window is at its minimum, so the box the close writes can be
        # compared against a reading of the same file rather than against a number.
        compact_saved = saved_bounds(work)
        report.check("the window really shrinks to the minimum",
                     wide_rect is not None and compact_rect is not None
                     and compact_rect[0] < wide_rect[0],
                     f"wide={wide_rect} compact={compact_rect}")
        narrow = showing_names()
        report.check("both pages are still reachable at 340x400", TABS <= narrow,
                     f"{len(TABS & narrow)}/{len(TABS)} visible")
        report.check("the app bar's primary actions survive 340x400", APPBAR_NARROW <= narrow,
                     ",".join(sorted(APPBAR_NARROW - narrow)))
        report.check("the branch chip survives 340x400", "Switch branch" in narrow)

        A.click(A.find_button(name="Main"))
        time.sleep(1.2)
        narrow = showing_names()
        report.check("Main carries the window cluster at 340x400", WINDOW_CLUSTER <= narrow,
                     ",".join(sorted(WINDOW_CLUSTER - narrow)))
        report.check("the commit box survives 340x400", "Commit message" in narrow)
        # The two regions are one page, and a page that only fits one of them at
        # the minimum size is the layout failure this whole stage exists to
        # catch: the graph is there, scrollable or capped, not gone.
        report.check("the commit history shares the page at 340x400", "Commit history" in narrow)
        report.check("a file row's actions survive 340x400",
                     any(name.startswith("More actions for ") for name in narrow))

        A.click(A.find_button(name="Settings"))
        time.sleep(1.2)
        narrow = showing_names()
        # Interface zoom lives in Settings, not in a permanent status-bar
        # cluster. Same rule as the Commit button above: the affordance has to
        # survive, not both copies of it, so it is checked where it lives.
        # Checked for *reach*, not for visibility: three sections were added to
        # this page and it is now taller than the minimum window, so the row is
        # legitimately off screen and a keyboard user scrolls to it. The claim
        # that matters is that focusing it puts it on the screen.
        for control in sorted(ZOOM):
            outcome = reach(control)
            report.check(f"{control} is reachable at 340x400",
                         outcome in ("on screen", "reached by focus"), outcome)
        A.click(A.find_button(name="Restore window size"))
        restored = document_rect(refuse_width=compact_rect[0] if compact_rect else None)
        # Still on Settings, so the landmark is Settings' own content. Read it
        # through the text channel: a plain label span has no accessible *name*,
        # so showing_names() — which is controls only — can never see it.
        after_restore = "Interface zoom" in A.dump()
        report.check("the page content is on screen after restore", after_restore,
                     "" if after_restore else "no Settings label in the text dump")
        # The restore is asserted as the width the window had before the shrink,
        # within a compositor rounding allowance. Width only, for the reason in
        # document_rect: the height would be a claim about content, not frame.
        report.check("the window restores to the width it had before the shrink",
                     wide_rect is not None and restored is not None
                     and abs(restored[0] - wide_rect[0]) <= 16,
                     f"wide={wide_rect} compact={compact_rect} restored={restored}")

        # --- close it the way the app bar offers ---
        # The press is the last thing this suite does, because it is the end of the only
        # route a window ever leaves by: the app bar's close is a request, the close hook
        # is what answers it, and the answer is to write the box down and then destroy the
        # window. Whether that happened is read from the process and from the file — the
        # tree is gone as soon as it does, so there is no third channel left to check it
        # with. Nothing is held here: no operation is running, which is the case in which
        # the panel is allowed to go straight away.
        A.click(A.find_button(name="Close guit"))
        ended = True
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            ended = False
        report.check("the app bar's close ends the application on its own", ended,
                     "" if ended else "still running fifteen seconds after the press")
        final_saved = saved_bounds(work) if ended else None
        report.check("the close leaves the window's box written down", final_saved is not None,
                     "" if final_saved is not None else "no readable window.json")
        if final_saved is not None and compact_saved is not None:
            # The restore happened between the two readings, so what the close stored must
            # be wider than the minimum it was shrunk to — the box the window actually had.
            report.check(
                "what the close wrote down is the box the window had then, not the minimum it was shrunk to",
                final_saved["width"] > compact_saved["width"],
                f"compact={compact_saved['width']} final={final_saved['width']}")
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), 15)
        except (OSError, ProcessLookupError):
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), 9)
        log.close()
        subprocess.run(["rm", "-rf", work], check=False)

    print(f"\nfails={len(report.fails)}: {report.fails}")
    return 1 if report.fails else 0


if __name__ == "__main__":
    sys.exit(main())
