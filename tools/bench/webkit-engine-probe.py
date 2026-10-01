#!/usr/bin/env python3
"""Run a rendering probe inside the engine guit actually displays through.

The fixture suite runs the appearance models in Node, where there is no stylesheet
parser, no font engine and no cascade. That is where a decision belongs and not
where a mechanism gets assumed: whether a constructed `CSSStyleSheet` parses,
whether writing a `<style>` changes computed style and can be undone, whether a
refused font stack still measures the row it says it does. Those are WebKitGTK
facts, and the only way to have them is to ask WebKitGTK.

This opens one offscreen WebKitWebView, bundles a probe entry against the panel's
own source, loads it over `http://127.0.0.1` (a normal origin, like the dev
server the panel runs on), calls `__probe()` and prints the checks it returns.

A probe that measures geometry needs the sheet the panel actually ships, so a
`.css` argument is copied into what is served and linked before the bundle. A
relative `@import` is followed so the served copy is the whole stylesheet, not a
file whose tokens are missing; one that steps outside the app directory is refused
rather than served, because a probe measuring against a sheet that is not the
panel's is evidence about nothing.

Usage: webkit-engine-probe.py [-v] [--window=WIDTHxHEIGHT] [entry.ts|sheet.css ...]
       (default entry: theme-engine-probe.ts; default window 900x700)

`-v` prints the detail of every check, not only the failed ones: a passing
measurement is still the number the next reader wants.

`--window` draws the probe in a different window, because a claim about a height
that a window caps is only worth what the measured shape says. The shape is
printed with the result, so a passing number cannot be read as another shape's.

Needs a display, the WebKitGTK GObject bindings, and the app's installed
node_modules for esbuild. A failure here is a rendering fact, not a flaky test:
read the detail column before changing the code it checked.
"""

import functools
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent.parent / "app"
ESBUILD = APP / "node_modules" / ".bin" / "esbuild"
SCRIPT = "window.__probe ? window.__probe() : 'NO-PROBE'"
IMPORT_RE = re.compile(r"""@import\s+(?:url\()?\s*["']([^"']+)["']""")


def fail(message: str) -> int:
    print(f"fails=1: {message}")
    return 1


def bundle(entries: list[Path], into: Path) -> list[Path]:
    if not ESBUILD.exists():
        raise SystemExit(f"no esbuild at {ESBUILD}; run npm ci in app/ first")
    outs = []
    for entry in entries:
        out = into / f"{entry.stem}.js"
        done = subprocess.run(
            [str(ESBUILD), str(entry), "--bundle", "--format=iife", "--target=es2022", f"--outfile={out}"],
            cwd=str(APP),
            capture_output=True,
            text=True,
        )
        if done.returncode != 0:
            raise SystemExit(f"bundling {entry.name} failed:\n{done.stderr}")
        outs.append(out)
    return outs


def serve_sheet(source: Path, into: Path, at: str, seen: set[Path]) -> None:
    """Copy one stylesheet, and anything it imports relatively, into what is served."""
    resolved = source.resolve()
    if resolved in seen:
        return
    if not resolved.is_file():
        raise SystemExit(f"no stylesheet at {source}")
    if APP not in resolved.parents:
        raise SystemExit(f"{source} is outside app/, so the panel never loads it either")
    seen.add(resolved)

    text = resolved.read_text(encoding="utf8")
    target = into / at
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf8")
    for one in IMPORT_RE.finditer(text):
        name = one.group(1)
        if "://" in name or name.startswith("/"):
            continue
        linked = (resolved.parent / name).resolve()
        serve_sheet(linked, into, f"{at.rsplit('/', 1)[0]}/{name}" if "/" in at else name, seen)


def serve(directory: Path) -> tuple[http.server.ThreadingHTTPServer, str]:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True

    server = Server(("127.0.0.1", port), functools.partial(Quiet, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{port}/probe.html"


def read_result(result) -> str:
    # The binding hands back a JavaScriptCore value, and the name it is filed under
    # changed between WebKitGTK versions.
    for name in ("to_string", "to_json"):
        accessor = getattr(result, name, None)
        if accessor is not None:
            return accessor() if name == "to_string" else accessor(0)
    for name in ("get_js_value", "get_value"):
        accessor = getattr(result, name, None)
        if accessor is None:
            continue
        value = accessor()
        if value is None:
            continue
        text = getattr(value, "to_string", None)
        return text() if text is not None else str(value)
    raise RuntimeError(f"cannot read a value of type {type(result).__name__}")


def run_one(bundle_path: Path, sheets: list[str], verbose: bool, size: tuple[int, int]) -> int:
    from gi.repository import GLib, Gtk, WebKit2  # noqa: PLC0415 - only after the display check

    directory = bundle_path.parent
    links = "".join(f"<link rel='stylesheet' href='{one}'>" for one in sheets)
    (directory / "probe.html").write_text(
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        f"<title>engine probe</title>{links}</head>"
        f"<body><script src='{bundle_path.name}'></script></body></html>",
        encoding="utf8",
    )
    server, uri = serve(directory)

    view = WebKit2.WebView()
    window = Gtk.OffscreenWindow()
    window.set_default_size(*size)
    window.add(view)
    window.show_all()

    outcome: dict = {}
    submit = "evaluate_javascript" if hasattr(view, "evaluate_javascript") else "run_javascript"
    finish = f"{submit}_finish"

    def on_load(_view, event):
        if event != WebKit2.LoadEvent.FINISHED:
            return False

        def done(_v, task, _data):
            try:
                outcome["json"] = read_result(getattr(view, finish)(task))
            except Exception as error:  # noqa: BLE001 - printed, not swallowed
                outcome["error"] = f"{type(error).__name__}: {error}"
            Gtk.main_quit()

        GLib.timeout_add(
            250,
            lambda: (
                getattr(view, submit)(SCRIPT, len(SCRIPT), None, None, None, done, None)
                if submit == "evaluate_javascript"
                else getattr(view, submit)(SCRIPT, None, done, None),
                False,
            )[1],
        )
        return False

    view.connect("load-changed", on_load)
    GLib.timeout_add_seconds(60, Gtk.main_quit)
    view.load_uri(uri)
    Gtk.main()
    server.shutdown()
    window.destroy()
    while Gtk.events_pending():
        Gtk.main_iteration()

    if "error" in outcome:
        return fail(f"{uri} raised {outcome['error']}")
    text = outcome.get("json")
    if text is None:
        return fail(f"{uri} returned nothing before the deadline (is __probe defined?)")
    if text == "NO-PROBE":
        return fail(f"{uri} loaded a bundle with no __probe in it")

    report = json.loads(text)
    print(f"engine: {report['engine']}")
    # The shape belongs under the numbers it produced: what a window's own height
    # caps is a different measurement at 700px than at 400px, and a run that leaves
    # its height unstated cannot be told apart from either.
    print(f"window: {size[0]}x{size[1]}")
    failed = 0
    for row in report["checks"]:
        if row["ok"] and not verbose:
            print(f"ok:   {row['name']}")
        elif row["ok"]:
            print(f"ok:   {row['name']}  [{row['detail']}]")
        else:
            failed += 1
            print(f"FAIL: {row['name']}  [{row['detail']}]")
    print(f"\nfails={failed}")
    return 1 if failed else 0


def main() -> int:
    argv = [one for one in sys.argv[1:] if one != "-v"]
    verbose = len(argv) != len(sys.argv) - 1
    wanted = [one for one in argv if one.startswith("--window=")]
    if len(wanted) > 1:
        return fail("give one --window, not several")
    argv = [one for one in argv if not one.startswith("--window=")]
    shape = wanted[0].split("=", 1)[1] if wanted else "900x700"
    window = re.fullmatch(r"([1-9]\d*)x([1-9]\d*)", shape)
    if window is None:
        return fail(f"--window wants WIDTHxHEIGHT in pixels, not {shape}")
    size = (int(window.group(1)), int(window.group(2)))
    names = argv or ["theme-engine-probe.ts"]
    entries, sheets = [], []
    for name in names:
        path = Path(name)
        if not path.is_absolute():
            path = (HERE if (HERE / name).exists() else APP) / name
        if not path.exists():
            return fail(f"no probe entry or stylesheet at {path}")
        (sheets if path.suffix == ".css" else entries).append(path)
    if not entries:
        return fail("no probe entry: a stylesheet alone cannot answer anything")

    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        return fail("no display: this probe asks the real renderer and cannot run headless")
    try:
        import gi  # noqa: F401

        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
    except Exception as error:  # noqa: BLE001
        return fail(f"the WebKitGTK bindings are not usable here: {type(error).__name__}: {error}")

    work = Path(tempfile.mkdtemp(prefix="guit-engine-probe"))
    try:
        seen: set[Path] = set()
        served = []
        for sheet in sheets:
            serve_sheet(sheet, work, sheet.name, seen)
            served.append(sheet.name)
        codes = [run_one(out, served, verbose, size) for out in bundle(entries, work)]
        return max(codes)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
