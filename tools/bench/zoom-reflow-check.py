#!/usr/bin/python3
"""Zoom reflow: the page never needs more width than the window gives it.

The interface size is a shipped control, it is applied to the root font, and most
of the shell's measurements are in `rem` — so pressing Zoom in makes the layout
bigger without making the window bigger. That is fine while the rows can give way
and it is a defect when they cannot: the right-hand window cluster, the one set of
controls the outline promises on every page, simply stops being where the window
ends. Measured on this host before anything was fixed, a repository open at the
shipped 720-wide window fitted exactly at 16px, asked for 736 at 18px and 970 at
the 24px the control clamps to — and at that ceiling the four window buttons were
drawn from 74 to 250 pixels past the frame's right edge, so the panel had to be
scrolled sideways to reach its own close button.

The width rules that already hide things on this bar are keyed to the viewport in
CSS pixels, and a root-font change moves the rem demand without moving that
number. So nothing in the stylesheet sees this case, and a check has to. The check
runs both ways: the bar must still be one line at the size the build ships with,
because giving way downwards is only a fix while it stays the last resort, and the
page must stay inside the window at the largest size the control offers.

Two channels, picked for what they can see. The window's own box comes from the
frame's extents (`ATSPI_ROLE_FRAME`, named for the app). The page's demand comes
from the document node, which carries scrollable content rather than the frame, so
a document wider than the window is the same fact as "this page needs a sideways
scroll". Deep in the tree a row inside its own scrolling list may measure wider
than anything, which is why the assertion is not "no node is wider than the
window" — the header, footer and landmarks are read only to name the suspect when
the two numbers disagree. The last thing checked is the geometry of the one
control set that must not be lost: each of the four window buttons has to sit
inside the frame's own box, on both pages, at the largest size the control offers.

Usage: /usr/bin/python3 zoom-reflow-check.py <release-binary> <fixture-repo> <work-dir>
Needs python3-gi and a live AT-SPI bus; the release binary comes from
`npm run bin:release`.
"""

import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_landmark as A  # noqa: E402

WINDOW_CLUSTER = {"Always on top", "Minimise", "Maximise window", "Close guit"}
# Where the size can be driven to, and back. The panel clamps the number itself, so
# this is a ceiling on how far the run will push, not a claim about the range.
MAX_STEPS = 8


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


def frame_box():
    """The window's own box, polled until it has one."""
    for _ in range(20):
        for node in A.tree(A.app_root()):
            if (A._once(lambda: node.get_role().value_name, default="") or "") != "ATSPI_ROLE_FRAME":
                continue
            if (A._once(lambda: node.get_name(), default="") or "") != "guit":
                continue
            extent = A._once(lambda: node.get_component().get_extents(A.Atspi.CoordType.SCREEN), default=None)
            if extent is not None and extent.width > 0:
                return extent
        time.sleep(0.25)
    return None


def boxes_by_role():
    """Widths of the page's own structure, keyed by role.

    The document node is the page's demand: it carries scrollable content rather
    than the frame, so a document wider than the window is exactly a page that has
    to be scrolled sideways. The header, footer and landmarks are read alongside it
    only to name the suspect when that comparison fails.
    """
    found = {}
    for node in A.tree(A.app_root()):
        role = (A._once(lambda: node.get_role().value_name, default="") or "").replace("ATSPI_ROLE_", "").lower()
        if role not in ("document_web", "header", "footer", "landmark", "list", "table"):
            continue
        extent = A._once(lambda: node.get_component().get_extents(A.Atspi.CoordType.SCREEN), default=None)
        if extent is None:
            continue
        current = found.get(role)
        if current is None or extent.width > current[0]:
            found[role] = (extent.width, extent.height)
    return found


def control_box(name):
    """The box of one window-cluster control.

    Two roles answer for a control on this bar: an HTML `button` reaches the bus as
    `ATSPI_ROLE_BUTTON`, and the pin carries `aria-pressed`, which the engine reports
    as a toggle button. Matching one role alone reads as a control that is drawn in
    full going missing, so such a guess would fail for the wrong reason.
    """
    for node in A.tree(A.app_root()):
        role = A._once(lambda: node.get_role().value_name, default="") or ""
        if not role.endswith("_BUTTON"):
            continue
        if (A._once(lambda: node.get_name(), default="") or "") != name:
            continue
        extent = A._once(lambda: node.get_component().get_extents(A.Atspi.CoordType.SCREEN), default=None)
        if extent is not None and extent.width > 0:
            return extent
    return None


def shown_size():
    """The size the Settings page writes on its own row, in pixels."""
    match = re.search(r"(\d+)px", A.dump())
    return int(match.group(1)) if match else None


def on_one_line(left, right):
    """Whether the two named controls are drawn in the same line of the bar.

    A row that has wrapped puts its second group below the first, so the two boxes
    stop sharing a vertical band. This is a shape claim read off two extents, not a
    height compared to a number: the bar's own height is a token that denser
    settings change, while "the close button is beside the branch, not under it" is
    the fact the shipped look rests on.
    """
    a, b = control_box(left), control_box(right)
    if a is None or b is None:
        return None
    return a.y < b.y + b.height and b.y < a.y + a.height


def click_named(name):
    return A.click(A.find_button(name=name))


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    binary, repo, work = sys.argv[1], sys.argv[2], sys.argv[3]
    subprocess.run(["rm", "-rf", work], check=True)
    prepare(work, repo)
    log = open(os.path.join(work, "app.log"), "w", encoding="utf-8")
    env = environment(work)
    process = subprocess.Popen([binary], env=env, stdout=log, stderr=log, start_new_session=True)
    report = Report()
    try:
        A.Atspi.init()
        if A.wait_for(r"Commit message", 30) is None:
            report.check("the app reaches the panel", False, "no commit box in the tree")
            print("FAIL: the app never reached the panel")
            return 1
        steps_up = 0
        seen = []
        # The shipped look, read before anything is moved. Wrapping the bar is the fix
        # for a page that runs out of width, and a bar that wrapped at the size the
        # build ships with would trade a sideways scroll for a taller header nobody
        # asked for — so the one-line shape is asserted here, at the size it must hold.
        click_named("Main")
        time.sleep(1.0)
        shipped = on_one_line("Switch branch", "Always on top")
        report.check("the app bar keeps the window cluster beside the branch at the shipped size",
                     shipped is True, f"same_line={shipped!r}")
        click_named("Settings")
        time.sleep(1.0)
        start_size = shown_size()
        report.check("the Settings page reports the interface size", start_size is not None, f"shown={start_size!r}")
        for _ in range(MAX_STEPS):
            before = shown_size()
            if not click_named("Zoom in"):
                break
            time.sleep(0.7)
            after = shown_size()
            if after is None or after == before:
                break
            steps_up += 1
            seen.append(after)
        report.check("the interface size can actually be moved", steps_up > 0, f"steps={steps_up} sizes={seen}")

        # Ask on both pages: the app bar is shared and the Main page is the one that
        # carries the widest rows.
        for page in ("Main", "Settings"):
            if not click_named(page):
                report.check(f"{page} is reachable", False)
                continue
            time.sleep(1.2)
            frame = frame_box()
            if frame is None:
                report.check(f"{page} has a window to measure", False)
                continue
            size = seen[-1] if seen else "?"
            widths = boxes_by_role()
            page_width = (widths.get("document_web") or (None,))[0]
            report.check(f"{page} does not outgrow its window at the largest interface size {size}px",
                         page_width is not None and page_width <= frame.width,
                         f"window={frame.width} page={page_width!r} suspects="
                         + str({role: box for role, box in sorted(widths.items()) if box[0] > frame.width}))
            outside = []
            for control in sorted(WINDOW_CLUSTER):
                box = control_box(control)
                if box is None:
                    outside.append(f"{control}:missing")
                elif box.x + box.width > frame.x + frame.width or box.y + box.height > frame.y + frame.height:
                    outside.append(f"{control}@{box.x}+{box.width}")
            report.check(f"{page} keeps all four window buttons inside the window at {size}px",
                         not outside,
                         f"window={frame.x}..{frame.x + frame.width} " + ",".join(outside))
    finally:
        try:
            os.killpg(os.getpgid(process.pid), 15)
        except (OSError, ProcessLookupError):
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(process.pid), 9)
        log.close()
        subprocess.run(["rm", "-rf", work], check=False)

    print(f"\nfails={len(report.fails)}: {report.fails}")
    return 1 if report.fails else 0


if __name__ == "__main__":
    sys.exit(main())
