#!/usr/bin/python3
"""M7 theme check: both token sets ship, and the control drives the store.

Two halves, because AT-SPI cannot read the value back out of a WebKit <select>
on this host (the combo has a single unnamed child and never reports the
selected option):

- static: the built stylesheet carries a light and a dark token set, and the
  tokens they disagree on are the ones that decide legibility;
- runtime: each option can be picked over AT-SPI, and the value that lands in
  the webview's localStorage is the one that was picked.

Usage: theme-check.py <release-binary> <fixture-repo> <work-dir> [built-css]
"""

import glob
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_landmark as A  # noqa: E402

# Tokens whose values must differ between the two sets, or one of the themes is
# not a theme.
DECIDING_TOKENS = ["--surface-app", "--surface-panel", "--text", "--text-muted", "--line", "--accent"]
OPTIONS = ["Light", "Dark", "Follow system"]


class Report:
    def __init__(self):
        self.fails = []

    def check(self, label, ok, detail=""):
        print(("ok:   " if ok else "FAIL: ") + label + (f"  [{detail}]" if detail else ""), flush=True)
        if not ok:
            self.fails.append(label)


def token_block(css, name):
    """Every `--token: value` pair inside `[data-theme=<name>]`'s rule.

    The minified bundle drops the attribute quotes, so both spellings count.
    """
    for selector in (f'[data-theme="{name}"]', f"[data-theme={name}]"):
        index = css.find(selector)
        if index >= 0:
            end = css.find("}", index)
            return dict(re.findall(r"(--[a-z0-9-]+)\s*:\s*([^;}]+)", css[index:end]))
    return {}


def static_check(report, built_css):
    target = os.path.abspath(built_css)
    sheets = sorted(glob.glob(os.path.join(target, "*.css"))) if os.path.isdir(target) else [target]
    if not sheets:
        report.check("the built stylesheet is present", False, built_css)
        return
    css = "".join(open(path, encoding="utf-8").read() for path in sheets)
    light = token_block(css, "light")
    dark = token_block(css, "dark")
    report.check("the stylesheet ships a light token set", bool(light), ",".join(sorted(light)[:4]))
    report.check("the stylesheet ships a dark token set", bool(dark), ",".join(sorted(dark)[:4]))
    differing = [token for token in DECIDING_TOKENS if light.get(token) != dark.get(token)]
    report.check("the two token sets differ on every deciding token",
                 len(differing) == len(DECIDING_TOKENS),
                 "same: " + ",".join(t for t in DECIDING_TOKENS if t not in differing))
    report.check("the system default is honoured when no override is set",
                 "prefers-color-scheme" in css and ":root" in css)
    for token in DECIDING_TOKENS:
        if token not in light and token not in dark:
            report.check(f"{token} is defined in both sets", False)


def runtime_check(report, binary, repo, work):
    home = work
    subprocess.run(["rm", "-rf", home], check=True)
    for sub in (".config/dev.guit.desktop", ".cache", "runtime"):
        os.makedirs(os.path.join(home, sub), exist_ok=True)
    with open(os.path.join(home, ".config/dev.guit.desktop/session.json"), "w", encoding="utf-8") as handle:
        handle.write('{"schema_version": 1, "path": "%s"}\n' % os.path.abspath(repo))
    env = dict(os.environ, HOME=home, XDG_CONFIG_HOME=os.path.join(home, ".config"),
               XDG_CACHE_HOME=os.path.join(home, ".cache"), XDG_RUNTIME_DIR=os.path.join(home, "runtime"))
    log = open(os.path.join(home, "app.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([binary], env=env, stdout=log, stderr=log, start_new_session=True)

    def stored_theme():
        """The theme override currently in the webview's localStorage.

        The database is a SQLite file whose write-ahead log holds the newest
        values, so the three files are copied into a scratch directory and only
        the copy is opened: opening the originals would checkpoint the log and
        rewrite the app's own state.
        """
        source = os.path.join(home, ".local/share/dev.guit.desktop/localstorage")
        scratch = os.path.join(home, ".theme-scratch")
        subprocess.run(["rm", "-rf", scratch], check=True)
        os.makedirs(scratch, exist_ok=True)
        for path in glob.glob(os.path.join(source, "tauri_localhost_0.localstorage*")):
            shutil.copy(path, scratch)
        database = os.path.join(scratch, "tauri_localhost_0.localstorage")
        if not os.path.exists(database):
            return None, {}
        connection = sqlite3.connect(database)
        try:
            rows = {
                key: (value.decode("utf-16-le", "replace") if isinstance(value, bytes) else value)
                for key, value in connection.execute("select key, value from ItemTable")
            }
        except sqlite3.Error:
            return None, {}
        finally:
            connection.close()
        return rows.get("guit.theme"), rows

    def read_store(wanted, attempts=4):
        """Read the store until it matches, or give up and report what it held.

        The webview flushes localStorage on its own schedule, so a read taken
        the instant after a pick can still see the previous value.
        """
        actual, rows = stored_theme()
        for attempt in range(attempts):
            if wanted(actual, rows):
                return actual, rows, attempt
            time.sleep(0.5)
            actual, rows = stored_theme()
        return actual, rows, attempts - 1

    try:
        A.Atspi.init()
        A.wait_for(r"Commit message", 30)
        A.click(A.find_button(name="Settings"))
        time.sleep(1.0)
        combo = None
        for node in A.tree(A.app_root()):
            if (A._once(lambda: node.get_name(), default="") or "") == "Theme" and (
                    A._once(lambda: node.get_role().value_name, default="") or "") == "ATSPI_ROLE_COMBO_BOX":
                combo = node
        report.check("the Theme select is reachable", combo is not None)
        for label, expected in (("Light", "light"), ("Dark", "dark"), ("Follow system", None)):
            if combo is None:
                break
            A.click(combo)
            time.sleep(0.6)
            item = None
            for node in A.tree(A.app_root()):
                if (A._once(lambda: node.get_role().value_name, default="") or "") == "ATSPI_ROLE_MENU_ITEM" and (
                        A._once(lambda: node.get_name(), default="") or "") == label:
                    item = node
                    break
            report.check(f"option \u201c{label}\u201d is offered", item is not None)
            report.check(f"option \u201c{label}\u201d can be picked", item is not None and A.click(item))
            time.sleep(0.8)
            wanted = (lambda value, _rows: value is None) if expected is None else (
                lambda value, _rows: value == expected)
            actual, rows, attempt = read_store(wanted)
            if expected is None:
                # "Follow system" is the absence of an override, not a stored value.
                report.check("picking \u201cFollow system\u201d clears the override", actual is None,
                             f"stored={actual!r}")
            else:
                report.check(f"picking \u201c{label}\u201d persists {expected}", actual == expected,
                             f"stored={actual!r}")
            report.check(f"the interface zoom preference survives the {label} switch",
                         rows.get("guit.fontPx") == "16",
                         f"stored={rows.get('guit.fontPx')!r} rows={sorted(rows)} after {attempt + 1} read(s)")
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


def main():
    binary, repo, work = sys.argv[1], sys.argv[2], sys.argv[3]
    built_css = sys.argv[4] if len(sys.argv) > 4 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "app", "dist", "assets")
    report = Report()
    static_check(report, built_css)
    runtime_check(report, binary, repo, work)
    print(f"\nfails={len(report.fails)}: {report.fails}")
    return 1 if report.fails else 0


if __name__ == "__main__":
    sys.exit(main())
