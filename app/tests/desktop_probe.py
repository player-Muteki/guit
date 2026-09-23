import gi
import sys
import time

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi


def print_tree(node, depth=0):
    if depth > 12:
        return
    name = node.get_name()
    role = node.get_role_name()
    value = Atspi.Text.get_text(node, 0, -1) if node.is_text() else ""
    if role == "check box":
        value = "checked" if node.get_state_set().contains(Atspi.StateType.CHECKED) else "unchecked"
    if role == "button":
        value = "enabled" if node.get_state_set().contains(Atspi.StateType.ENABLED) else "disabled"
    print(f"{'  ' * depth}{role}: {name or value}{f' [{value}]' if role in {'check box', 'button'} else ''}")
    for child_index in range(min(node.get_child_count(), 100)):
        child = node.get_child_at_index(child_index)
        if child is not None:
            print_tree(child, depth + 1)


def find_named(node, name):
    if node.get_name() == name:
        return node
    for child_index in range(node.get_child_count()):
        child = node.get_child_at_index(child_index)
        if child is not None:
            found = find_named(child, name)
            if found is not None:
                return found
    return None


desktop = Atspi.get_desktop(0)
for application_index in range(desktop.get_child_count()):
    application = desktop.get_child_at_index(application_index)
    if application.get_name() == "guit":
        if len(sys.argv) > 1 and sys.argv[1] == "--cancel-probe":
            run_button = find_named(application, "Run probe")
            cancel_button = find_named(application, "Cancel")
            if run_button is None or cancel_button is None:
                raise SystemExit("Process controls are missing")
            Atspi.Action.do_action(run_button, 0)
            time.sleep(0.2)
            Atspi.Action.do_action(cancel_button, 0)
            time.sleep(1)
        elif len(sys.argv) > 1:
            target = find_named(application, sys.argv[1])
            if target is None or not Atspi.Action.do_action(target, 0):
                raise SystemExit(f"Cannot activate {sys.argv[1]}")
            time.sleep(4 if sys.argv[1] == "Run probe" else 1)
        print_tree(application)
        break
else:
    raise SystemExit("guit accessibility application not found")
