#!/usr/bin/python3
"""M7 shell smoke over AT-SPI (one protocolised run).

Covers what recovery-checks.sh and diagnostics-export-check.sh do not: that
every activity-rail view opens and shows its own content, that a row menu
works, that the discard ticket's cancel path closes the modal, returns focus to
the button that opened it and changes nothing on disk, and that a failed
external tool is surfaced.

Landmark rules are the one in atspi_landmark.py, plus three this script needs:
- a menu item is a `menuitem`, not a `button`, so row and app-bar menus are
  looked up by role as well as by name;
- a closed <dialog> keeps its node in the WebKit accessibility tree and keeps
  reporting SHOWING, so "the modal is gone" is asserted through the status line
  and through the working copy on disk, not through absence;
- the file list is virtualised, so only the groups inside the rendered window
  are asserted, and the fixture is small enough to fit all of them.

Focus is deliberately not asserted: on this host AT-SPI reports FOCUSED
stickily (a control keeps the state after another control is clicked), and
`do_action` does not move DOM focus, so neither reading nor writing focus can
be measured over AT-SPI. See plan/M7-validation.md.

Usage: view-smoke.py <release-binary> <fixture-repo> <work-dir> [--keep]
Prints one line per assertion; exits non-zero when any assertion fails.
"""

import argparse
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_landmark as A  # noqa: E402

# Rail item -> a string that can only come from that view's own content.
VIEWS = [
    ("Changes", r"Commit message"),
    ("History", r"Load older|No commits yet"),
    ("Branches & Tags", r"New branch|Search"),
    ("Stash", r"Stash changes|Save changes|Your stash"),
    ("Remotes", r"Add remote|Fetch|Publish"),
    ("Worktrees & Submodules", r"Add worktree|Submodules|Linked worktrees"),
    ("Settings", r"Interface zoom|Export diagnostics"),
]

# From fileModel.ts GROUP_LABELS. "Changes" is the work-tree group, so it is
# matched with its count to tell it apart from the view title.
DIRTY_GROUPS = [r"Staged changes", r"Changes \(\d+\)", r"Untracked files"]


class Report:
    def __init__(self):
        self.fails = []

    def check(self, label, ok, detail=""):
        print(("ok:   " if ok else "FAIL: ") + label + (f"  [{detail}]" if detail else ""), flush=True)
        if not ok:
            self.fails.append(label)


def find(name, role=None):
    """First node whose name matches exactly, optionally restricted by role."""
    for node in A.tree(A.app_root()):
        if role is not None and (A._once(lambda: node.get_role().value_name, default="") or "") != role:
            continue
        if (A._once(lambda: node.get_name(), default="") or "") == name:
            return node
    return None


def states(node):
    if node is None:
        return []
    return A._once(lambda: [s.value_name for s in node.get_state_set().get_states()], default=[]) or []


def focused(node):
    return "ATSPI_STATE_FOCUSED" in states(node)


def porcelain(repo):
    return subprocess.run(["git", "-C", repo, "status", "--porcelain"],
                          capture_output=True, text=True).stdout


def row_buttons():
    return [node for node in A.tree(A.app_root())
            if (A._once(lambda: node.get_role().value_name, default="") or "") == "ATSPI_ROLE_BUTTON"
            and (A._once(lambda: node.get_name(), default="") or "").startswith("More actions for ")]


def open_menu_with(*wanted):
    """Open the first row menu that offers one of `wanted`; return its items.

    An untracked file legitimately has no "Diff" (it has no HEAD side), so the
    driver has to look for a row whose menu actually contains the action it
    wants to exercise. Clicking the same row button again toggles its menu shut,
    which is how the driver moves on without pressing Escape.
    """
    for row in row_buttons():
        A.click(row)
        time.sleep(0.5)
        items = [A._once(lambda: node.get_name(), default="") or "" for node in A.tree(A.app_root())
                 if (A._once(lambda: node.get_role().value_name, default="") or "") == "ATSPI_ROLE_MENU_ITEM"]
        if any(item in wanted for item in items):
            return items
        A.click(row)
        time.sleep(0.3)
    return []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("repo")
    parser.add_argument("work")
    parser.add_argument("--keep", action="store_true", help="keep the isolated HOME")
    args = parser.parse_args()

    home = args.work
    subprocess.run(["rm", "-rf", home], check=True)
    for sub in (".config/dev.guit.desktop", ".cache", "runtime"):
        os.makedirs(os.path.join(home, sub), exist_ok=True)
    with open(os.path.join(home, ".config/dev.guit.desktop/session.json"), "w", encoding="utf-8") as handle:
        handle.write('{"schema_version": 1, "path": "%s"}\n' % os.path.abspath(args.repo))

    env = dict(os.environ, HOME=home, XDG_CONFIG_HOME=os.path.join(home, ".config"),
               XDG_CACHE_HOME=os.path.join(home, ".cache"), XDG_RUNTIME_DIR=os.path.join(home, "runtime"))
    log = open(os.path.join(home, "app.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([args.binary], env=env, stdout=log, stderr=log, start_new_session=True)
    report = Report()
    try:
        A.Atspi.init()
        report.check("the Changes view renders its commit box",
                     A.wait_for(r"Commit message", 30) is not None)
        report.check("the watch mode is announced in the status bar",
                     A.wait_for(r"Monitor: ", 20) is not None)

        # --- every rail view opens and shows its own content ---
        for view, needle in VIEWS:
            item = A.find_button(name=view)
            if item is None:
                report.check(f"view {view}: rail item present", False)
                continue
            A.click(item)
            time.sleep(0.8)
            report.check(f"view {view} opens with its own content",
                         A.wait_for(needle, 8) is not None, needle)

        A.click(A.find_button(name="Changes"))
        time.sleep(0.8)

        # --- the change groups a dirty fixture must produce ---
        blob = A.dump()
        for pattern in DIRTY_GROUPS:
            report.check(f"group heading /{pattern}/ renders", re.search(pattern, blob) is not None)

        # --- per-row action menu (menuitem, not button) ---
        items = open_menu_with("Diff")
        report.check("a tracked file row opens a menu with Diff", "Diff" in items, ",".join(items))
        if "Diff" in items:
            A.click(find("Diff", "ATSPI_ROLE_MENU_ITEM"))
            time.sleep(2.5)
            report.check("a failed external tool is surfaced",
                         A.wait_for(r"diff tool|external tool", 6) is not None)

        # --- the discard ticket: preview, cancel, nothing consumed ---
        before = porcelain(args.repo)
        trigger = A.find_button(name="Discard all")
        report.check("the work-tree group offers Discard all", trigger is not None)
        A.click(trigger)
        time.sleep(1.2)
        report.check("discard opens the confirm modal with its warning",
                     A.wait_for(r"cannot be recovered", 10) is not None)
        report.check("the modal lists the candidate files", A.wait_for(r"src/file", 4) is not None)
        A.click(find("Keep changes", "ATSPI_ROLE_BUTTON"))
        time.sleep(1.0)
        report.check("cancel is confirmed in the status line",
                     A.wait_for(r"Cancelled; nothing was changed\.", 5) is not None)
        report.check("cancel discarded nothing", before == porcelain(args.repo))
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
        if not args.keep:
            subprocess.run(["rm", "-rf", home], check=False)

    print(f"\nfails={len(report.fails)}: {report.fails}")
    return 1 if report.fails else 0


if __name__ == "__main__":
    sys.exit(main())
