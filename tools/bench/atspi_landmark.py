#!/usr/bin/env python3
"""AT-SPI landmark helpers for the guit M6 bench harness (M6-01).

Measured driver rules carried over from the M4/M5 smoke drivers:
- visibility is decided by presence in the accessibility tree only
  (off-viewport nodes report SHOWING=false but are reachable);
- per-node reads must not retry-sleep (the WebKit tree populates lazily,
  five sleeps per node would starve every poll);
- Accessible.get_text is the deprecated single-argument form here: the
  working call is the static Atspi.Text.get_text(node, 0, count).
"""

import re

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402


def _once(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def app_root():
    for i in range(Atspi.get_desktop(0).get_child_count()):
        child = _once(lambda: Atspi.get_desktop(0).get_child_at_index(i))
        if child is None:
            continue
        name = _once(lambda: child.get_name(), default="") or ""
        if "guit" in name.lower():
            return child
    return None


def tree(root=None):
    node = root if root is not None else app_root()
    if node is None:
        return []
    nodes = []
    stack = [node]
    while stack:
        current = stack.pop()
        nodes.append(current)
        count = _once(lambda: current.get_child_count(), default=0) or 0
        for index in range(count):
            child = _once(lambda: current.get_child_at_index(index))
            if child is not None:
                stack.append(child)
    return nodes


def node_text(node):
    name = _once(lambda: node.get_name(), default="") or ""
    count = _once(lambda: node.get_character_count(), default=0) or 0
    text = ""
    if count > 0:
        text = _once(lambda: Atspi.Text.get_text(node, 0, count), default="") or ""
    return name + "\n" + text


def dump(root=None):
    return "\n".join(node_text(node) for node in tree(root))


def find_button(name=None, contains=None, root=None):
    for node in tree(root):
        if _once(lambda: node.get_role().value_name, default="") != "ATSPI_ROLE_BUTTON":
            continue
        label = _once(lambda: node.get_name(), default="") or ""
        if (name is not None and label == name) or (
            contains is not None and contains in label
        ):
            return node
    return None


def click(button, attempts=5):
    for _ in range(attempts):
        if button is not None and _once(lambda: button.do_action(0), default=False):
            return True
    return False


def wait_for(text_re, deadline_s, root_hint=None):
    """Poll the whole-tree text until the regex matches; return the match."""
    import time

    deadline = time.time() + deadline_s
    while time.time() < deadline:
        match = re.search(text_re, dump(root_hint))
        if match:
            return match
        time.sleep(0.02)
    return None
