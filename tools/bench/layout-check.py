#!/usr/bin/python3
"""Layout checks over AT-SPI geometry.

The functional smoke suites assert that the right controls exist and that the
right text is announced. They are blind to layout: a view can pass all of them
while its sections are painted on top of each other and none of it is legible.
That happened — the Settings view's three blocks were squashed by a column
flex container and their text overflowed into each other, and every
accessibility assertion still passed.

AT-SPI exposes laid-out geometry, so the failure modes that matter can be
asserted rather than eyeballed. Three of them, all of which are unambiguous:

- overlap:    two nodes that both render text and whose boxes intersect. Two
              readable strings drawn over each other is never intentional.
- overflow:   a node whose text extends past the viewport's right edge. In a
              resizable window this is horizontal scroll or clipped content.
- invisible:  a node that reports SHOWING, carries text, and has a box too
              small to draw it in — content that is in the tree and on screen
              but not on the display.

What this cannot see, stated plainly: a row whose text was ellipsised reports a
box that is still inside the viewport, because truncating a string is a
legitimate layout. A real defect of exactly that shape — a worktree row whose
absolute path lost its tail at 340px — passed this check and was found by
looking at a screenshot. Passing here means "not painted on top of itself", not
"well laid out".

The branch picker is therefore not measured here. It covers the panel with an
opaque layer, and the panel keeps its laid-out boxes underneath: with no z-order
in the tree, every row of the page under the layer reads as an overlap with the
layer's own rows. Whether a covering layer actually covers, and whether what it
covers stays out of the way, is a question about paint order — layout-probe.mjs
answers it in a renderer that has one.

Usage: layout-check.py <release-binary> <fixture-repo> <work-dir> [width height]
The binary must be built with the custom-protocol feature (`npm run
bin:release`); a dev-url binary renders an error page instead of the app.
Exits non-zero when any page or overlay state fails.

A gate that cannot fail is not a gate, so verify it by breaking the layout on
purpose: this one was developed against a build with the Settings fix removed,
which it reports as failing. Keep that property when adding checks.
"""

import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_landmark as A  # noqa: E402

# Two boxes may legitimately touch; only a real intersection is a defect.
OVERLAP_SLOP = 2
# A text node smaller than this in either axis cannot be legible.
MIN_BOX = 6

# The two pages, by the name their tab item carries. Each is measured with the
# panel's own landmark in it, so a page that failed to lay out its regions is
# caught before the overlay states are.
PAGES = [
    ("Main", r"Commit message"),
    ("Settings", r"Interface zoom|Export diagnostics"),
]

# Fixed window chrome. These do not scroll with the document body, so their
# extents live in a different coordinate space from scrolling content. Comparing
# a chrome box against a content box therefore reports overlaps that no one can
# see, so the overlap check only compares like with like.
CHROME_ROLES = {
    "ATSPI_ROLE_STATUS_BAR",
    "ATSPI_ROLE_HEADER",
}

# The window's fixed bars. Anything laid out inside one of these boxes is chrome.
CHROME_BOX_ROLES = {
    "ATSPI_ROLE_FOOTER",
    "ATSPI_ROLE_HEADER",
}

# WebKitGTK exposes <dt>/<dd> as description terms and values with a usable
# box but no name and no text interface, so node_text() cannot label them.
# Their geometry is exactly what a narrow layout breaks, so they are checked
# as anonymous rectangles instead of being skipped.
GEOMETRY_ONLY_ROLES = {
    "ATSPI_ROLE_DESCRIPTION_TERM": "<dt>",
    "ATSPI_ROLE_DESCRIPTION_VALUE": "<dd>",
}

# Roles that draw readable text. Container roles (document, section, panel,
# group, form) are deliberately absent: they enclose their children, so
# comparing them against anything reports the whole page as overlapping itself.
# Anything missing from this list is invisible to the overlap check, so it has to
# cover every element the views can render text into, not just the ones that
# happened to matter first.
TEXT_ROLES = {
    "ATSPI_ROLE_PARAGRAPH", "ATSPI_ROLE_HEADING", "ATSPI_ROLE_LABEL",
    "ATSPI_ROLE_STATIC", "ATSPI_ROLE_LIST_ITEM", "ATSPI_ROLE_STATUS_BAR",
    "ATSPI_ROLE_ENTRY", "ATSPI_ROLE_COMBO_BOX", "ATSPI_ROLE_NOTIFICATION",
    "ATSPI_ROLE_PUSH_BUTTON", "ATSPI_ROLE_BUTTON", "ATSPI_ROLE_CHECK_BOX",
    "ATSPI_ROLE_MENU_ITEM", "ATSPI_ROLE_LINK", "ATSPI_ROLE_RADIO_BUTTON",
    "ATSPI_ROLE_DESCRIPTION_TERM", "ATSPI_ROLE_DESCRIPTION_VALUE",
}


def node_text(node):
    name = A._once(lambda: node.get_name(), default="") or ""
    count = A._once(lambda: node.get_character_count(), default=0) or 0
    text = ""
    if count > 0:
        text = A._once(lambda: A.Atspi.Text.get_text(node, 0, count), default="") or ""
    return (name + "\n" + text).strip()


def extent_box(node):
    """The node's reported extent, including a degenerate one.

    A missing extent and a zero-area extent mean different things. A missing one
    means the node does not report geometry; a zero-area one means the node is
    collapsed, which is how WebKitGTK reports a closed popup. `rect` drops the
    degenerate case, so this exists to keep it visible.
    """
    extent = A._once(lambda: node.get_component().get_extents(A.Atspi.CoordType.SCREEN), default=None)
    if extent is None:
        return None
    return (extent.x, extent.y, extent.width, extent.height)


def rect(node):
    box = extent_box(node)
    if box is None or box[2] <= 0 or box[3] <= 0:
        return None
    return box


def showing(node):
    states = A._once(lambda: [s.value_name for s in node.get_state_set().get_states()], default=[]) or []
    return "ATSPI_STATE_SHOWING" in states


def has_text_descendant(node):
    stack = [node]
    while stack:
        current = stack.pop()
        for index in range(A._once(lambda: current.get_child_count(), default=0) or 0):
            child = A._once(lambda c=current, i=index: c.get_child_at_index(i))
            if child is None:
                continue
            if node_text(child):
                return True
            stack.append(child)
    return False


def children(node):
    out = []
    for index in range(A._once(lambda: node.get_child_count(), default=0) or 0):
        child = A._once(lambda c=node, i=index: c.get_child_at_index(i))
        if child is not None:
            out.append(child)
    return out


def visible_text_nodes():
    """Leaf text boxes: a node whose own text is not repeated by a child.

    Without the leaf filter a `role=paragraph` that wraps a button reports the
    same string twice and the same rectangle twice, and every row looks like it
    overlaps itself.

    Two WebKitGTK artefacts are filtered here, because both invent overlaps that
    no one can see:

    * A closed popup menu keeps its items in the tree with a real-looking box,
      all stacked on the menu's own rectangle, while the menu itself reports a
      zero-area box and no states. Anything under a collapsed ancestor is not
      on screen, so it is not measured.
    * Elements inside the window's fixed bars are chrome. They do not scroll
      with the body, so their extents live in a different coordinate space from
      scrolling content and must not be compared against it.
    """
    chrome_boxes = [
        rect(node) for node in A.tree(A.app_root())
        if (A._once(lambda: node.get_role().value_name, default="") or "") in CHROME_BOX_ROLES
        and rect(node) is not None
    ]
    out = []
    # Each stack entry carries whether a collapsed ancestor was seen.
    stack = [(A.app_root(), False)]
    while stack:
        node, collapsed_ancestor = stack.pop()
        raw = extent_box(node)
        if collapsed_ancestor or (raw is not None and (raw[2] <= 0 or raw[3] <= 0)):
            continue
        role = A._once(lambda: node.get_role().value_name, default="") or ""
        box = rect(node)
        if role in TEXT_ROLES:
            text = node_text(node)
            if (text or role in GEOMETRY_ONLY_ROLES) and showing(node) and not has_text_descendant(node):
                if box is not None:
                    chrome = role in CHROME_ROLES or any(inside(box, region) for region in chrome_boxes)
                    out.append((role, text or GEOMETRY_ONLY_ROLES[role], box, chrome))
        for child in reversed(children(node)):
            stack.append((child, collapsed_ancestor))
    return out


def inside(box, region):
    rx, ry, rw, rh = region
    x, y, w, h = box
    return x >= rx - 1 and y >= ry - 1 and x + w <= rx + rw + 1 and y + h <= ry + rh + 1



def overlaps(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = min(ax + aw, bx + bw) - max(ax, bx)
    iy = min(ay + ah, by + bh) - max(ay, by)
    return ix > OVERLAP_SLOP and iy > OVERLAP_SLOP


def find(name, role=None):
    for node in A.tree(A.app_root()):
        if role is not None and (A._once(lambda: node.get_role().value_name, default="") or "") != role:
            continue
        if (A._once(lambda: node.get_name(), default="") or "") == name:
            return node
    return None


class Report:
    def __init__(self):
        self.fails = []

    def fail(self, label, detail):
        self.fails.append(label)
        print(f"FAIL: {label}\n        {detail}", flush=True)


def check_state(report, label, viewport):
    """`viewport` is the document's own screen rect (x, y, width, height)."""
    nodes = visible_text_nodes()
    left, right = viewport[0], viewport[0] + viewport[2]

    # --- overlap: readable text drawn on readable text ---
    reported = 0
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            if nodes[i][3] != nodes[j][3]:
                continue
            if not overlaps(nodes[i][2], nodes[j][2]):
                continue
            a_text = nodes[i][1].replace("\n", " ")[:40]
            b_text = nodes[j][1].replace("\n", " ")[:40]
            reported += 1
            if reported <= 3:
                report.fail(
                    f"{label}: text overlaps text",
                    f"{nodes[i][0]} {nodes[i][2]} {a_text!r}  ×  "
                    f"{nodes[j][0]} {nodes[j][2]} {b_text!r}")
    if reported > 3:
        report.fail(f"{label}: text overlaps text", f"{reported} overlapping pairs in total")

    # --- overflow: content past the edges of the document box ---
    for role, text, box, _chrome in nodes:
        if box[0] + box[2] > right + 1:
            report.fail(
                f"{label}: content overflows the viewport to the right",
                f"{role} right edge {box[0] + box[2]} > {right}  {text.replace(chr(10), ' ')[:40]!r}")
        if box[0] < left - 1:
            report.fail(
                f"{label}: content overflows the viewport to the left",
                f"{role} left edge {box[0]} < {left}  {text.replace(chr(10), ' ')[:40]!r}")

    # --- invisible: announced and showing, but too small to draw ---
    for role, text, box, _chrome in nodes:
        if box[2] < MIN_BOX or box[3] < MIN_BOX:
            report.fail(
                f"{label}: visible text has no room to be drawn",
                f"{role} {box}  {text.replace(chr(10), ' ')[:40]!r}")


def viewport_rect(attempts=20):
    """The document's own box, which is the reference for "does not overflow".

    A webview that has just switched views reports a zero extent for a moment,
    so this polls rather than reading once. There is deliberately no fallback
    to the window frame: the frame is a different box, and comparing content
    against it invents overflow that is not there.
    """
    for _ in range(attempts):
        for node in A.tree(A.app_root()):
            if (A._once(lambda: node.get_role().value_name, default="") or "") == "ATSPI_ROLE_DOCUMENT_WEB":
                box = rect(node)
                if box:
                    return box
        time.sleep(0.25)
    return None



def main():
    binary, repo, work = sys.argv[1], sys.argv[2], sys.argv[3]
    width = int(sys.argv[4]) if len(sys.argv) > 4 else 400
    height = int(sys.argv[5]) if len(sys.argv) > 5 else 760

    subprocess.run(["rm", "-rf", work], check=True)
    for sub in (".config/dev.guit.desktop", ".cache", "runtime"):
        os.makedirs(os.path.join(work, sub), exist_ok=True)
    with open(os.path.join(work, ".config/dev.guit.desktop/session.json"), "w", encoding="utf-8") as handle:
        handle.write('{"schema_version": 1, "path": "%s"}\n' % os.path.abspath(repo))
    # window.json stores physical pixels.
    with open(os.path.join(work, ".config/dev.guit.desktop/window.json"), "w", encoding="utf-8") as handle:
        handle.write('{"width":%d,"height":%d,"frameWidth":0,"frameHeight":0,'
                     '"x":40,"y":30,"alwaysOnTop":false,"maximized":false,"schemaVersion":1}\n'
                     % (width * 2, height * 2))
    env = dict(os.environ, HOME=work, XDG_CONFIG_HOME=os.path.join(work, ".config"),
               XDG_CACHE_HOME=os.path.join(work, ".cache"), XDG_RUNTIME_DIR=os.path.join(work, "runtime"))
    log = open(os.path.join(work, "app.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([binary], env=env, stdout=log, stderr=log, start_new_session=True)
    report = Report()
    try:
        A.Atspi.init()
        if A.wait_for(r"Commit message", 30) is None:
            # A gate that cannot say what it saw is not a gate. Show the tree.
            print("FAIL: the app never reached the panel; the tree held:")
            for line in [ln for ln in A.dump().splitlines() if ln.strip()][:40]:
                print(f"        {line}")
            report.fail("the app never reached the panel", "no commit box in the tree")
            return 1
        viewport = viewport_rect()
        if viewport is None:
            print("FAIL: the webview never reported a usable size")
            return 1
        print(f"document box: x={viewport[0]} y={viewport[1]} w={viewport[2]} h={viewport[3]}")

        for page, needle in PAGES:
            A.click(A.find_button(name=page))
            A.wait_for(needle, 10)
            time.sleep(1.0)
            before = len(report.fails)
            check_state(report, f"page {page}", viewport)
            if len(report.fails) == before:
                print(f"ok:   page {page} lays out cleanly")

        # Overlay states: a row action menu and the destructive dialog.
        A.click(A.find_button(name="Main"))
        A.wait_for(r"Commit message", 10)
        time.sleep(0.8)
        rows = [n for n in A.tree(A.app_root())
                if (A._once(lambda: n.get_name(), default="") or "").startswith("More actions for ")]
        if rows:
            A.click(rows[0])
            time.sleep(0.8)
            before = len(report.fails)
            check_state(report, "overlay row menu", viewport)
            if len(report.fails) == before:
                print("ok:   overlay row menu lays out cleanly")
            item = find("Open", "ATSPI_ROLE_MENU_ITEM")
            if item:
                A.click(item)
            time.sleep(0.6)
        discard = A.find_button(name="Discard all")
        if discard:
            A.click(discard)
            time.sleep(1.4)
            before = len(report.fails)
            check_state(report, "overlay confirm dialog", viewport)
            if len(report.fails) == before:
                print("ok:   overlay confirm dialog lays out cleanly")
            keep = find("Keep changes", "ATSPI_ROLE_BUTTON")
            if keep:
                A.click(keep)
            time.sleep(0.6)
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
        # A failing run is untrustworthy without the app's own stderr, so keep it.
        if report.fails:
            kept = work + ".app.log"
            try:
                with open(os.path.join(work, "app.log"), encoding="utf-8") as src, \
                     open(kept, "w", encoding="utf-8") as dst:
                    dst.write(src.read())
                print(f"app log kept at {kept}")
            except OSError:
                pass
        subprocess.run(["rm", "-rf", work], check=False)

    print(f"\nfails={len(report.fails)}")
    return 1 if report.fails else 0


if __name__ == "__main__":
    sys.exit(main())
