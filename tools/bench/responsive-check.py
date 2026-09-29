#!/usr/bin/env python3
"""Responsive-geometry gate for the guit stylesheet.

The functional smoke suites (view-smoke, narrow-smoke) drive a real window and
can only ever visit the sizes someone thought to click through. They cannot
tell you that a rule still says `30vh` after the short-window breakpoints were
added, and `30vh` is exactly the value that hands a detail pane 190px in a
1400x420 letterbox window.

So the invariants that decide whether the layout survives an unusual shape are
asserted here against the stylesheet itself, where they are cheap and total:

- every `vh` is gone: height shares run through a token, because a bare `vh`
  cannot be adjusted per shape and a `vh` is the one unit that ignores zoom;
- every fixed chrome height is a token, so a root font-size change moves it;
- the two axes are both covered: a stylesheet that only asks `max-width` has
  no answer for a wide, short window;
- no `min-width` in px sits on a text-bearing element, because a px floor is
  the one thing that cannot give its space back when the window shrinks.

    Usage: responsive-check.py [<style.css> [<tokens.css>]]
"""

import os
import re
import sys


class Report:
    def __init__(self):
        self.fails = []

    def check(self, label, ok, detail=""):
        print(("ok:   " if ok else "FAIL: ") + label + (f"  [{detail}]" if detail else ""))
        if not ok:
            self.fails.append(label)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    style = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "..", "app", "src", "style.css")
    tokens = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "..", "..", "app", "src", "style", "tokens.css")
    css = open(style, encoding="utf-8").read()
    token_css = open(tokens, encoding="utf-8").read()
    report = Report()

    # 0. Braces balance, per file. A missing `}` after an @media silently
    #    swallows every following rule into that media condition: the tokens
    #    still look right in the source and the tokens still look right in the
    #    built bundle, but at runtime none of them apply. It cost an afternoon
    #    of "the breakpoint matches and the value is still wrong", and the only
    #    reason it survived is that no check ever counted braces.
    for path, source in ((style, css), (tokens, token_css)):
        bare = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
        opened, closed = bare.count("{"), bare.count("}")
        report.check(f"{os.path.basename(path)} has balanced braces", opened == closed,
                     f"{opened} open, {closed} close")
        depth = 0
        escaped_at = None
        for index, char in enumerate(bare):
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth < 0:
                    escaped_at = bare[:index].count("\n") + 1
                    break
        report.check(f"{os.path.basename(path)} never closes more than it opens",
                     escaped_at is None, f"an extra }} near line {escaped_at}" if escaped_at else "")

    # 1. No bare viewport-height lengths outside a comment.
    stripped = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    vh = re.findall(r"\b\d+(?:\.\d+)?vh\b", stripped)
    report.check("no bare vh in the stylesheet (height shares are tokens)",
                 not vh, " ".join(sorted(set(vh))))

    # 2. The tokens those shares now run through actually exist, in both the
    #    base block and the short-window overrides.
    for token in ("--detail-cap", "--list-cap", "--gutter", "--gutter-tight",
                  "--block-gap", "--tab-min-width", "--tab-item-size", "--splitter-size"):
        report.check(f"{token} is declared", token in token_css)
    for token in ("--detail-cap", "--list-cap", "--appbar-height", "--statusbar-height"):
        report.check(f"{token} is restated for a short window", token_css.count(token) >= 2,
                     f"declared {token_css.count(token)}x")

    # 3. Both axes are covered by a media query. The height breakpoints live
    #    in tokens.css because they only restate token values, so the scan
    #    covers both stylesheets: a gate that only read style.css would pass
    #    on a stylesheet that has no answer for a short window at all.
    whole = stripped + "\n" + re.sub(r"/\*.*?\*/", "", token_css, flags=re.S)
    queries = [match.strip() for match in re.findall(r"@media\s*([^{]+)\{", whole)]
    has_width = any("width" in query for query in queries)
    has_height = any("height" in query for query in queries)
    report.check("a breakpoint asks about width", has_width)
    report.check("a breakpoint asks about height", has_height,
                 "a stylesheet that only asks max-width has no answer for a 1400x420 window")
    combined = [query for query in queries if "width" in query and "height" in query]
    report.check("a breakpoint asks about shape (both axes at once)", bool(combined),
                 combined[0] if combined else "e.g. min-width 1200px and max-height 460px")

    # 4. Fixed chrome is tokenised rather than typed in, so zoom moves it.
    fixed = re.findall(r"(?:\.appbar|\.statusbar|\.tab-item|\.splitter)\s*\{[^}]*?height:\s*([\d.]+)px", stripped)
    report.check("no fixed px height on the app bar, status bar, tab item or splitter",
                 not fixed, " ".join(fixed))

    # 5. A px min-width on a text-bearing element is a floor the window cannot
    #    reclaim; the shell's own body floor is allowed, and is 320px to match
    #    the declared minimum in tauri.conf.json.
    px_floors = re.findall(r"\.([a-z-]+)[^{]*\{[^}]*?min-width:\s*(\d+)px", stripped)
    offenders = [(name, value) for name, value in px_floors if name != "body"]
    report.check("no px min-width outside body", not offenders,
                 " ".join(f"{name}={value}px" for name, value in offenders))
    body = re.search(r"\bbody\s*\{[^}]*?min-width:\s*(\d+)px", stripped)
    report.check("the body floor matches the declared minimum window (tauri minWidth)",
                 body is not None and int(body.group(1)) <= 340,
                 f"body min-width={body.group(1) if body else '?'}px vs minWidth=340px")

    # 6. The row-height contract the virtual lists depend on must survive: the
    #    test in file-model.mjs compares FILE_ROW_REM against this value.
    match = re.search(r"--row-height:\s*([\d.]+)rem", token_css)
    history = re.search(r"--row-height-history:\s*([\d.]+)rem", token_css)
    report.check("--row-height is still 1.5rem (fileModel.FILE_ROW_REM)",
                 match is not None and abs(float(match.group(1)) - 1.5) < 1e-9,
                 match.group(1) if match else "missing")
    report.check("--row-height-history is still 1.5rem (fileModel.HISTORY_ROW_REM)",
                 history is not None and abs(float(history.group(1)) - 1.5) < 1e-9,
                 history.group(1) if history else "missing")

    # 7. Zoom range and the stylesheet's largest fixed text size have to be
    #    able to coexist with the minimum window, or the app bar clips.
    report.check("text sizes are tokens, not hard-coded px", not re.search(r"font-size:\s*[\d.]+px", stripped))

    print(f"\nfails={len(report.fails)}: {report.fails}")
    return 1 if report.fails else 0


if __name__ == "__main__":
    sys.exit(main())
