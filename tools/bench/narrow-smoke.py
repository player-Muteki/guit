#!/usr/bin/python3
"""M7 narrow-window smoke over AT-SPI.

Drives Settings → Developer "Test compact window", which resizes the window to
the project's declared 340x400 minimum, and asserts the shell's primary actions
are still in the accessibility tree at that size. Horizontal overflow is not
directly observable over AT-SPI, so what is asserted is that nothing a user
needs disappears at the minimum size.

Usage: narrow-smoke.py <release-binary> <fixture-repo> <work-dir>
"""

import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_landmark as A  # noqa: E402

RAIL = {"Changes", "History", "Branches & Tags", "Stash", "Remotes",
        "Worktrees & Submodules", "Settings"}
APPBAR = {"Open repository", "Refresh status", "Sync", "Commit", "Always on top"}
# At the minimum width the app bar drops its Commit button, because the Changes
# footer already carries a commit box in the same place. The affordance has to
# survive, not both copies of it, so it is checked where it lives instead.
APPBAR_NARROW = APPBAR - {"Commit"}
ZOOM = {"Zoom in", "Zoom out", "Reset zoom"}


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
            report.check("the app reaches the Changes view", False, "no commit box in the tree")
            print("FAIL: the app never reached the Changes view")
            return 1
        wide = showing_names()
        report.check("the app bar's primary actions are visible when wide", APPBAR <= wide,
                     ",".join(sorted(APPBAR - wide)))
        report.check("the whole activity rail is visible when wide", RAIL <= wide,
                     ",".join(sorted(RAIL - wide)))

        # --- shrink to the declared minimum, 340x400 ---
        A.click(A.find_button(name="Settings"))
        time.sleep(1.0)
        A.click(A.find_button(name="Test compact window"))
        time.sleep(2.5)
        narrow = showing_names()
        report.check("the activity rail survives 340x400", RAIL <= narrow,
                     f"{len(RAIL & narrow)}/{len(RAIL)} visible")
        report.check("the app bar's primary actions survive 340x400", APPBAR_NARROW <= narrow,
                     ",".join(sorted(APPBAR_NARROW - narrow)))
        report.check("the branch chip survives 340x400", "Switch branch" in narrow)

        A.click(A.find_button(name="Changes"))
        time.sleep(1.2)
        narrow = showing_names()
        report.check("the commit box survives 340x400", "Commit message" in narrow)
        report.check("a file row's actions survive 340x400",
                     any(name.startswith("More actions for ") for name in narrow))

        A.click(A.find_button(name="Settings"))
        time.sleep(1.2)
        narrow = showing_names()
        # Interface zoom lives in Settings, not in a permanent status-bar
        # cluster. Same rule as the Commit button above: the affordance has to
        # survive, not both copies of it, so it is checked where it lives.
        report.check("the interface zoom controls survive 340x400", ZOOM <= narrow,
                     ",".join(sorted(ZOOM - narrow)))
        A.click(A.find_button(name="Restore window size"))
        time.sleep(2.0)
        # Still on Settings, so the landmark is Settings' own content.
        report.check("the window restores to a usable size", "Interface zoom" in showing_names())
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
