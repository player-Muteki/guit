#!/usr/bin/python3
"""M7 shell smoke over AT-SPI (one protocolised run).

Covers what recovery-checks.sh and diagnostics-export-check.sh do not: that
every activity-rail view opens and shows its own content, that a row menu
works, that the discard ticket's cancel path closes the modal, returns focus to
the button that opened it and changes nothing on disk, that a failed external
tool is surfaced, and that the developer probe's cancel really reaps its
child.

Landmark rules are the one in atspi_landmark.py, plus three this script needs:
- a menu item is a `menuitem`, not a `button`, so row and app-bar menus are
  looked up by role as well as by name;
- a closed <dialog> keeps its node in the WebKit accessibility tree and keeps
  reporting SHOWING, so "the modal is gone" is asserted through the status line
  and through the working copy on disk, not through absence;
- the file list is virtualised, so only the groups inside the rendered window
  are asserted, and the fixture is small enough to fit all of them.

Focus *is* asserted, on both paths a confirm dialog can take: cancelling one
whose trigger survived hands focus back to that trigger, and cancelling one
whose trigger was rebuilt while the dialog was open hands it to the documented
substitute. A control experiment (click a rail item: nothing stays focused)
ruled out the earlier reading that AT-SPI's FOCUSED state is sticky here.

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


def focused_name(role=None):
    """The name of the one control that holds focus, if any."""
    for node in A.tree(A.app_root()):
        if not focused(node):
            continue
        if role is not None and (A._once(lambda: node.get_role().value_name, default="") or "") != role:
            continue
        name = A._once(lambda: node.get_name(), default="") or ""
        if name:
            return name
    return None


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
        # Focus must not stay on the closed dialog's own button. "Discard all"
        # lives in a virtualised row that the preview's snapshot already
        # rebuilt, so the documented substitute is the activity-rail item.
        report.check("focus leaves the closed dialog", focused_name("ATSPI_ROLE_BUTTON") == "Changes",
                     f"focus is on {focused_name('ATSPI_ROLE_BUTTON')!r}")

        # --- the same dialog when the trigger *is* still there ---
        # Settings' export button is ordinary chrome, so cancelling its content
        # manifest must hand focus back to that exact button.
        A.click(A.find_button(name="Settings"))
        time.sleep(1.0)
        A.click(A.find_button(name="Export diagnostics…"))
        time.sleep(1.0)
        report.check("the export manifest opens",
                     A.wait_for(r"plain-text diagnostics report", 8) is not None)
        A.click(find("Cancel", "ATSPI_ROLE_BUTTON"))
        time.sleep(1.0)
        report.check("focus returns to the button that opened the dialog",
                     focused_name("ATSPI_ROLE_BUTTON") == "Export diagnostics…",
                     f"focus is on {focused_name('ATSPI_ROLE_BUTTON')!r}")

        # --- the cancellable process probe ---
        # `git hash-object --stdin` is given no input and its stdin is held
        # open for three seconds before being closed, so the probe is reliably
        # still running when the cancel lands a moment later. That is what
        # makes this a test of the *cancelled* path rather than a race with a
        # fast completion: the button swap is the only thing asserted, and the
        # result line has to say the child was reaped.
        run_probe = A.find_button(name="Run probe")
        cancel_probe = A.find_button(name="Cancel probe")
        report.check("the developer probe offers Run and Cancel",
                     run_probe is not None and cancel_probe is not None)
        if run_probe is not None and cancel_probe is not None:
            report.check("Cancel probe starts disabled",
                         "ATSPI_STATE_ENABLED" not in states(cancel_probe))
            A.click(run_probe)
            time.sleep(0.3)
            # Both buttons are rebuilt by the same handler, so the enabled
            # state is read again rather than cached from before the click.
            report.check("Run probe disables itself and enables Cancel probe",
                         "ATSPI_STATE_ENABLED" not in states(A.find_button(name="Run probe"))
                         and "ATSPI_STATE_ENABLED" in states(A.find_button(name="Cancel probe")))
            A.click(cancel_probe)
            report.check("a cancelled probe reports the child was reaped",
                         A.wait_for(r"cancelled and reaped", 20) is not None)
            report.check("Run probe is offered again after a cancelled probe",
                         "ATSPI_STATE_ENABLED" in states(A.find_button(name="Run probe"))
                         and "ATSPI_STATE_ENABLED" not in states(A.find_button(name="Cancel probe")))
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
