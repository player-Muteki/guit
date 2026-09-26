#!/usr/bin/env python3
"""Colour-contrast gate for the guit token set.

A pastel scheme is the easy way to ship an unreadable tool: macaron surfaces
are pretty precisely because they are low-contrast, and the moment a soft
lavender carries 13px body text at 4.2:1 nobody can read a branch name. The
pretty part of "pastel" is therefore only allowed to live in the *surfaces*
and the *fills*; every token that carries text or a 2px status rail has to
clear the ratio a sighted user needs, in both schemes.

This script is the gate for that claim, and it fails the same way the other
gates do: by exiting non-zero. Standalone (no third-party dependency) so it
runs anywhere the app is built.

    Usage: color-contrast.py [<tokens.css> ...]
"""

import glob
import os
import re
import sys


def _srgb_to_linear(channel):
    channel = channel / 255.0
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    red, green, blue = (_srgb_to_linear(value) for value in rgb)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast(foreground, background):
    first, second = luminance(foreground), luminance(background)
    if first < second:
        first, second = second, first
    return (first + 0.05) / (second + 0.05)


def parse_hex(value):
    match = re.fullmatch(r"#([0-9a-fA-F]{3,8})", value.strip())
    if not match:
        return None
    digits = match.group(1)
    if len(digits) in (3, 4):
        digits = "".join(digit * 2 for digit in digits)
    if len(digits) == 6:
        digits += "ff"
    if len(digits) != 8:
        return None
    return tuple(int(digits[index:index + 2], 16) for index in (0, 2, 4))


def parse_rgba(value):
    """`rgba(r, g, b, a)` -> ((r, g, b), a). Washes are translucent by design."""
    match = re.fullmatch(
        r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)", value.strip())
    if not match:
        return None
    red, green, blue, alpha = (float(part) for part in match.groups())
    return (int(red), int(green), int(blue)), alpha


def composite(top, alpha, bottom):
    """Flatten a translucent fill onto an opaque backdrop.

    A `rgba()` wash is not a colour a user perceives, it is a colour the
    browser paints over whatever is behind it, so its contrast has to be
    measured after compositing. Skipping this is how a "soft" danger wash ends
    up carrying a label at 2.8:1 and nothing notices.
    """
    return tuple(round(alpha * top[channel] + (1.0 - alpha) * bottom[channel])
                 for channel in range(3))


def resolve(tokens, name, backdrop):
    """A token's effective colour over `backdrop`, or None if unparseable."""
    value = tokens.get(name)
    if value is None:
        return None
    parsed = parse_hex(value)
    if parsed is not None:
        return parsed[:3]
    parsed = parse_rgba(value)
    if parsed is None:
        return None
    top, alpha = parsed
    return composite(top, alpha, backdrop)


def parse_tokens(css):
    """Every `--token: value` declaration, keyed by scheme then by token.

    The file declares the light scheme as a bare `:root` block and the dark
    scheme as `:root[data-theme="dark"]`, then restates whichever scheme has
    to *win* over the system preference inside a `prefers-color-scheme` query.
    So the system-dark block and the `data-theme="light"` block hold the same
    values, and reading only one of them would prove nothing about the other;
    both are merged into the scheme they name.
    """
    schemes = {"root": {}, "light": {}, "dark": {}}
    index = 0
    depth = 0
    block_start = 0
    while index < len(css):
        char = css[index]
        if char == "{":
            depth += 1
            block_start = index
        elif char == "}":
            depth -= 1
            if depth == 0:
                # Walk back to the character that begins this rule's selector.
                begin = 0
                for match in re.finditer(r"[{}]", css[:block_start]):
                    begin = match.end()
                selector = css[begin:block_start]
                name = None
                if re.search(r"data-theme\s*=\s*[\"']?dark", selector):
                    name = "dark"
                elif re.search(r"data-theme\s*=\s*[\"']?light", selector):
                    name = "light"
                elif re.search(r"(^|[\s,])root([\s,{:]|$)", selector):
                    # A media query that names the *other* scheme means this is
                    # the override for it; naming this scheme (or naming none)
                    # means this is the system default for that scheme.
                    system = re.findall(r"prefers-color-scheme\s*:\s*(\w+)", selector)
                    name = system[-1] if system and system[-1] in ("light", "dark") else "root"
                if name:
                    body = css[block_start + 1:index]
                    pairs = dict(re.findall(r"(--[a-z0-9-]+)\s*:\s*([^;}]+)", body))
                    if name == "root":
                        # The bare :root block is the light scheme.
                        schemes["light"].update(pairs)
                    else:
                        schemes[name].update(pairs)
        index += 1
    return schemes


# (foreground, background, minimum, why). The 3:1 pairs are the 2px status
# rail and other non-text indicators: WCAG 1.4.11 wants 3:1 for a graphical
# object, and on a file row the rail is the only colour carrier.
PAIRS = [
    ("--text", "--surface-app", 4.5, "body text on the app background"),
    ("--text", "--surface-panel", 4.5, "body text on a panel"),
    ("--text", "--surface-raised", 4.5, "body text on a raised surface"),
    ("--text", "--surface-sunken", 4.5, "body text on a sunken surface"),
    ("--text", "--surface-input", 4.5, "body text inside an input"),
    ("--text-muted", "--surface-app", 4.5, "secondary text on the app background"),
    ("--text-muted", "--surface-panel", 4.5, "secondary text on a panel"),
    ("--text-muted", "--surface-raised", 4.5, "secondary text on a raised surface"),
    ("--text-muted", "--surface-input", 4.5, "secondary text inside an input"),
    ("--text-faint", "--surface-app", 4.5, "tertiary text on the app background"),
    ("--text-faint", "--surface-panel", 4.5, "tertiary text on a panel"),
    ("--text-faint", "--surface-raised", 4.5, "tertiary text on a raised surface"),
    ("--accent", "--surface-app", 4.5, "an accent label on the app background"),
    ("--accent", "--surface-panel", 4.5, "an accent label on a panel"),
    ("--accent", "--surface-raised", 4.5, "an accent label on a raised surface"),
    ("--danger", "--surface-app", 4.5, "an error label on the app background"),
    ("--danger", "--surface-panel", 4.5, "an error label on a panel"),
    ("--danger", "--surface-raised", 4.5, "an error label on a raised surface"),
    ("--danger", "--danger-soft", 4.5, "a danger label on the danger wash"),
    ("--danger-text", "--danger", 4.5, "the label on a solid danger button"),
    ("--line-strong", "--surface-panel", 3.0, "a button border on a panel"),
    ("--line-strong", "--surface-raised", 3.0, "a button border on a raised surface"),
    ("--status-staged", "--surface-app", 3.0, "the staged status rail"),
    ("--status-staged", "--surface-panel", 3.0, "the staged status rail on a panel"),
    ("--status-modified", "--surface-app", 3.0, "the worktree status rail"),
    ("--status-modified", "--surface-panel", 3.0, "the worktree status rail on a panel"),
    ("--status-deleted", "--surface-app", 3.0, "the deleted status rail"),
    ("--status-deleted", "--surface-panel", 3.0, "the deleted status rail on a panel"),
    ("--status-renamed", "--surface-app", 3.0, "the renamed status rail"),
    ("--status-renamed", "--surface-panel", 3.0, "the renamed status rail on a panel"),
    ("--status-conflict", "--surface-app", 3.0, "the conflict status rail"),
    ("--status-conflict", "--surface-panel", 3.0, "the conflict status rail on a panel"),
    ("--status-untracked", "--surface-app", 3.0, "the untracked status rail"),
    ("--status-untracked", "--surface-panel", 3.0, "the untracked status rail on a panel"),
    ("--status-added", "--surface-panel", 4.5, "a success label in the status bar"),
    ("--status-ignored", "--surface-panel", 3.0, "the ignored status rail"),
    ("--line", "--surface-panel", 1.0, "a hairline on a panel (presence, not meaning)"),
    ("--line", "--surface-app", 1.0, "a hairline on the app background"),
]


def main():
    paths = sys.argv[1:] or [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                     "app", "src", "style", "tokens.css")]
    schemes = {"root": {}, "light": {}, "dark": {}}
    if os.path.isdir(paths[0]):
        # A directory means "every stylesheet the build produced", which is what
        # a gate should read: it has to judge the bundle that ships, not the
        # source. theme-check.py takes the same argument for the same reason.
        found = sorted(glob.glob(os.path.join(paths[0], "*.css")))
        if not found:
            print("FAIL: no stylesheet found in %s" % paths[0])
            return 1
        paths = found
    for path in paths:
        css = open(path, encoding="utf-8").read()
        for name, found_tokens in parse_tokens(css).items():
            schemes[name].update(found_tokens)

    fails = 0
    for scheme in ("light", "dark"):
        tokens = schemes[scheme]
        if not tokens:
            print("FAIL: no %s token set found" % scheme)
            fails += 1
            continue
        print("--- %s ---" % scheme)
        for foreground, background, minimum, why in PAIRS:
            if foreground not in tokens or background not in tokens:
                print("FAIL: %s / %s is missing from the %s set" % (foreground, background, scheme))
                fails += 1
                continue
            # A translucent background has to be flattened onto the surface it
            # is painted over before its contrast means anything.
            base = resolve(tokens, "--surface-app", (255, 255, 255)) or (255, 255, 255)
            second = resolve(tokens, background, base)
            first = resolve(tokens, foreground, second or base)
            if first is None or second is None:
                print("FAIL: %s or %s is not a colour in the %s set (%r / %r)"
                      % (foreground, background, scheme, tokens[foreground], tokens[background]))
                fails += 1
                continue
            ratio = contrast(first, second)
            ok = ratio >= minimum
            print("%s: %-22s on %-20s %5.2f:1 (need %.1f)  %s"
                  % ("ok:  " if ok else "FAIL:", foreground, background, ratio, minimum, why))
            if not ok:
                fails += 1
    print("\nfails=%d" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
