#!/usr/bin/python3
"""One protocolised guit run for the startup/idle baseline (external harness).

Launches the release binary against a seeded repository with an isolated
user-data directory, times the AT-SPI landmarks, samples the process-tree
memory/CPU from /proc at 100 ms, optionally measures watcher refresh
latency and history paging, then reports one JSON object. Requires
/usr/bin/python3 (python3-gi). Measurement tool names (07-quality-release
protocol): /proc VmRSS/VmHWM/stat, gi.repository.Atspi, CLOCK_MONOTONIC.
"""

import argparse
import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_landmark as A  # noqa: E402


def proc_tree(root_pid):
    """All descendants of root_pid read from /proc (children map built now)."""
    children = {}
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            with open(f"/proc/{pid}/stat", "rb") as handle:
                text = handle.read().decode("utf-8", "replace")
            ppid = int(text.rsplit(")", 1)[1].split()[1])
        except (OSError, IndexError, ValueError):
            continue
        children.setdefault(ppid, []).append(pid)
        pids.append(pid)
    found, stack = set(), [root_pid]
    while stack:
        pid = stack.pop()
        found.add(pid)
        stack.extend(children.get(pid, []))
    return sorted(found)


def sample(pids):
    """(rss_kb, hwm_kb, cpu_jiffies) summed over the given process tree."""
    rss = hwm = cpu = 0
    for pid in pids:
        try:
            with open(f"/proc/{pid}/status", "rb") as handle:
                for line in handle:
                    if line.startswith(b"VmRSS:"):
                        rss += int(line.split()[1])
                    elif line.startswith(b"VmHWM:"):
                        hwm += int(line.split()[1])
            with open(f"/proc/{pid}/stat", "rb") as handle:
                fields = handle.read().decode("utf-8", "replace").rsplit(")", 1)[1].split()
            cpu += int(fields[11]) + int(fields[12])
        except (OSError, IndexError, ValueError):
            continue
    return rss, hwm, cpu


class Sampler(threading.Thread):
    def __init__(self, root_pid, interval=0.1):
        super().__init__(daemon=True)
        self.root_pid = root_pid
        self.interval = interval
        self.samples = []  # (t, rss_kb, hwm_kb, cpu_jiffies)
        self.stop_flag = threading.Event()

    def run(self):
        while not self.stop_flag.is_set():
            pids = proc_tree(self.root_pid)
            rss, hwm, cpu = sample(pids)
            self.samples.append((time.monotonic(), rss, hwm, cpu))
            self.stop_flag.wait(self.interval)

    def halt(self):
        self.stop_flag.set()
        self.join(timeout=2)


def parse_perf(path):
    records = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                match = re.match(r"\[perf\] phase=(\S+) ms=([\d.]+)", line)
                if match:
                    records.append({"phase": match.group(1), "ms": float(match.group(2))})
    except OSError:
        pass
    return records


def inotify_watch_count(pids):
    total = 0
    for pid in pids:
        fd_dir = f"/proc/{pid}/fd"
        fdinfo = f"/proc/{pid}/fdinfo"
        try:
            for fd in os.listdir(fd_dir):
                try:
                    if os.readlink(os.path.join(fd_dir, fd)) != "anon_inode:inotify":
                        continue
                    with open(os.path.join(fdinfo, fd), "r", encoding="utf-8", errors="replace") as handle:
                        total += sum(1 for line in handle if "wd:" in line)
                except OSError:
                    pass
        except OSError:
            continue
    return total


def loaded_commits():
    """The graph's own loaded-commit count, from its status label.

    The label reads "50 commits so far." / "60 commits — all loaded."; the count
    is the only number that says how much history has arrived, and the rows
    themselves are virtualised, so counting nodes would measure the viewport.
    """
    match = re.search(r"(\d+) commits? (?:so far|[—-] all loaded)", A.dump())
    return int(match.group(1)) if match else None


def wait_for_count(at_least, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        count = loaded_commits()
        if count is not None and count >= at_least:
            return count
        time.sleep(0.02)
    return None


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--binary", required=True)
    args.add_argument("--repo", required=True)
    args.add_argument("--label", default="run")
    args.add_argument("--idle", type=float, default=30.0)
    args.add_argument("--touch", action="store_true", help="measure watcher refresh latency")
    args.add_argument("--history-pages", type=int, default=0)
    args.add_argument("--out", required=True)
    args.add_argument("--keep-home", default="")
    args = args.parse_args()

    home = args.keep_home or (
        args.out + ".home"
    )
    shutil.rmtree(home, ignore_errors=True)
    for sub in (".config", ".cache", "runtime"):
        os.makedirs(os.path.join(home, sub), exist_ok=True)
    config = os.path.join(home, ".config", "dev.guit.desktop")
    os.makedirs(config, exist_ok=True)
    with open(os.path.join(config, "session.json"), "w", encoding="utf-8") as handle:
        json.dump({"schema_version": 1, "path": os.path.abspath(args.repo)}, handle)

    env = dict(os.environ)
    env.update(
        HOME=home,
        XDG_CONFIG_HOME=os.path.join(home, ".config"),
        XDG_CACHE_HOME=os.path.join(home, ".cache"),
        XDG_RUNTIME_DIR=os.path.join(home, "runtime"),
        GUIT_PERF="1",
    )
    perf_log = args.out + ".perf.log"
    log_handle = open(perf_log, "w", encoding="utf-8")
    t0 = time.monotonic()
    proc = subprocess.Popen(
        [args.binary],
        env=env,
        stdout=log_handle,
        stderr=log_handle,
        start_new_session=True,
    )
    if not args.keep_home:
        atexit.register(lambda: shutil.rmtree(home, ignore_errors=True))

    result = {
        "label": args.label,
        "repo": os.path.abspath(args.repo),
        "pid": proc.pid,
        "binary": args.binary,
    }

    sampler = Sampler(proc.pid)
    sampler.start()

    # AT-SPI init can race a cold session bus; the app itself is already up.
    A.Atspi.init()
    l1 = l2 = None
    deadline = time.time() + 120
    while time.time() < deadline:
        text_blob = A.dump()
        # L1 is the shell: both page names are in the tree, so the window has
        # its navigation and a click could land somewhere.
        if l1 is None and re.search(r"\bMain\b", text_blob) and re.search(r"\bSettings\b", text_blob):
            l1 = time.monotonic() - t0
        # L2 is the Main panel drawn: its own content line is on screen and the
        # watcher has announced itself in the status bar. The commit graph is a
        # separate read that can land later, so it is deliberately not part of
        # either landmark; --history-pages below measures its paging.
        if (
            l2 is None
            and re.search(r"Monitor: ", text_blob)
            and re.search(r"Working copy is clean\.|Stage|Untracked|Conflicts", text_blob)
        ):
            l2 = time.monotonic() - t0
            break
        if proc.poll() is not None:
            break
        time.sleep(0.02)
    result["landmark_l1_s"] = l1
    result["landmark_l2_s"] = l2

    if args.touch and l2 is not None:
        marker = f"bench-touch-{int(time.time())}.txt"
        touch_t0 = time.monotonic()
        with open(os.path.join(args.repo, marker), "w", encoding="utf-8") as handle:
            handle.write("x\n")
        match = A.wait_for(re.escape(marker), 30)
        result["refresh_visible_latency_s"] = (time.monotonic() - touch_t0) if match else None
        os.remove(os.path.join(args.repo, marker))

    if args.history_pages and l2 is not None:
        # The graph shares the Main panel with the changes list, so it is
        # already in the tree. A page has arrived only when the loaded count
        # grows: the counter's mere presence is satisfied by the first page, and
        # measuring that would report a latency for work never done.
        page_times = []
        before = loaded_commits()
        if before is None:
            result["history_pages_measured"] = False
            result["history_pages_note"] = "no loaded-commit counter in the tree"
        else:
            result["history_pages_measured"] = True
            pages_done = 0
            for _ in range(args.history_pages):
                button = A.find_button(name="Load older")
                if button is None:
                    result["history_pages_note"] = "no Load older button (history already fully loaded)"
                    break
                started = time.monotonic()
                if not A.click(button):
                    # A refused click and a click on a button the app had just
                    # disabled are different facts; only the second one is the
                    # end of the history.
                    states = A._once(
                        lambda: [s.value_name for s in button.get_state_set().get_states()], default=[]) or []
                    result["history_pages_note"] = (
                        "Load older was disabled, so the history is fully loaded"
                        if "ATSPI_STATE_ENABLED" not in states
                        else "Load older is enabled but the click did not land")
                    break
                after = wait_for_count(before + 1, 30)
                if after is None:
                    result["history_pages_note"] = f"count stayed at {before} for 30s"
                    break
                page_times.append(time.monotonic() - started)
                before = after
                pages_done += 1
            if pages_done < args.history_pages and "history_pages_note" not in result:
                result["history_pages_note"] = "stopped early"
            result["history_page_latencies_s"] = page_times
    else:
        result["history_page_latencies_s"] = []
        result["history_pages_measured"] = False

    idle_start = time.monotonic()
    time.sleep(max(0.0, args.idle))
    sampler.halt()
    log_handle.flush()

    now_pids = proc_tree(proc.pid)
    result["inotify_watches"] = inotify_watch_count(now_pids)
    samples = sampler.samples
    idle_samples = [s for s in samples if s[0] >= idle_start]
    if len(idle_samples) >= 2:
        rss = sorted(sample_rss for _, sample_rss, _, _ in idle_samples)
        result["idle_rss_kb_min"] = rss[0]
        result["idle_rss_kb_median"] = rss[len(rss) // 2]
        result["idle_rss_kb_max"] = rss[-1]
        cpu_span = idle_samples[-1][3] - idle_samples[0][3]
        wall_span = idle_samples[-1][0] - idle_samples[0][0]
        hz = os.sysconf("SC_CLK_TCK")
        result["idle_cpu_cores_avg"] = cpu_span / hz / wall_span if wall_span > 0 else None
        result["idle_window_s"] = wall_span
    if samples:
        rss = sorted(sample_rss for _, sample_rss, _, _ in samples)
        result["rss_kb_min"] = rss[0]
        result["rss_kb_median"] = rss[len(rss) // 2]
        result["rss_kb_max"] = rss[-1]
        result["hwm_kb_peak"] = max(hwm for _, _, hwm, _ in samples)
        result["sample_count"] = len(samples)
        result["wall_s"] = samples[-1][0] - samples[0][0]

    # Per-process peak (main only) from its own VmHWM at last read.
    try:
        with open(f"/proc/{proc.pid}/status", "rb") as handle:
            for line in handle:
                if line.startswith(b"VmHWM:"):
                    result["main_hwm_kb"] = int(line.split()[1])
    except OSError:
        pass

    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
        proc.wait(timeout=5)
    log_handle.close()
    result["perf_records"] = parse_perf(perf_log)

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle)
        handle.write("\n")
    ok = result.get("landmark_l2_s") is not None and proc.returncode is not None
    print(json.dumps({k: v for k, v in result.items() if k != "perf_records"}))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
