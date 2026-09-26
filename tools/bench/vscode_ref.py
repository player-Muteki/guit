#!/usr/bin/python3
"""Bounded reference measurement: VS Code SCM sidebar on the same
fixture. Not a product benchmark — a scope-limited comparison of one window's
process tree (guit's tree includes WebKitGTK helpers; VS Code's includes
Electron helpers). Third-party extensions are excluded via an empty
--extensions-dir; the built-in git provider stays active."""

import argparse
import json
import os
import signal
import statistics
import subprocess
import sys
import threading
import time


def children_of(root_pid):
    pids = {root_pid}
    frontier = [root_pid]
    # Two levels is enough: code main -> zygote -> renderer/utility/extensionHost.
    for _ in range(3):
        next_frontier = []
        for pid in frontier:
            try:
                task = f"/proc/{pid}/task"
                for tid in os.listdir(task):
                    with open(f"{task}/{tid}/children") as handle:
                        for child in handle.read().split():
                            if child.isdigit() and int(child) not in pids:
                                pids.add(int(child))
                                next_frontier.append(int(child))
            except OSError:
                pass
        frontier = next_frontier
    return pids


def classify(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            args = handle.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return None, 0
    rss = 0
    try:
        with open(f"/proc/{pid}/status") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
                    break
    except OSError:
        pass
    if "extensionHost" in args or "extension-host" in args:
        kind = "extensionHost"
    elif "--type=renderer" in args:
        kind = "renderer"
    elif "--type=gpu-process" in args:
        kind = "gpu"
    elif "--type=utility" in args or "shared-process" in args:
        kind = "utility"
    elif "--type=zygote" in args:
        kind = "zygote"
    elif "code" in args or "electron" in args.lower():
        kind = "main"
    else:
        kind = "other"
    return kind, rss


class Sampler(threading.Thread):
    def __init__(self, root_pid):
        super().__init__(daemon=True)
        self.root_pid = root_pid
        self.samples = []  # list of {kind: rss_kb}, one dict per sample
        self.stop_flag = threading.Event()

    def run(self):
        while not self.stop_flag.is_set():
            pids = children_of(self.root_pid)
            bucket = {}
            for pid in pids:
                kind, rss = classify(pid)
                if kind is None:
                    continue
                bucket[kind] = bucket.get(kind, 0) + rss
            if bucket:
                self.samples.append(bucket)
            time.sleep(0.2)


def find_main(data_dir, timeout=30.0):
    """The /usr/bin/code launcher daemonizes and exits, so the spawned PID is
    useless. Find the real main process by its unique --user-data-dir."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as handle:
                    args = handle.read().decode("utf-8", "replace")
            except OSError:
                continue
            if data_dir in args and "--type=" not in args and "code" in args:
                return int(pid)
        time.sleep(0.2)
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", default="/usr/bin/code")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--warmup", type=float, default=20.0)
    parser.add_argument("--sample", type=float, default=30.0)
    args = parser.parse_args()

    work = args.out + ".vscodehome"
    os.makedirs(work + "/extensions", exist_ok=True)
    subprocess.run(
        [
            args.code,
            "--user-data-dir",
            work + "/data",
            "--extensions-dir",
            work + "/extensions",
            "--new-window",
            args.repo,
        ],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    main_pid = find_main(work + "/data")
    if main_pid is None:
        print(json.dumps({"error": "vscode main process not found"}))
        return 1
    time.sleep(args.warmup)
    sampler = Sampler(main_pid)
    sampler.start()
    time.sleep(args.sample)
    sampler.stop_flag.set()
    time.sleep(0.5)
    try:
        os.kill(main_pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

    kinds = sorted({kind for sample in sampler.samples for kind in sample})
    report = {"samples": len(sampler.samples), "by_kind_kb": {}, "totals_kb": {}}
    for kind in kinds:
        series = [s.get(kind, 0) for s in sampler.samples]
        report["by_kind_kb"][kind] = {
            "median": statistics.median(series),
            "max": max(series),
        }
    totals = [sum(s.values()) for s in sampler.samples]
    report["totals_kb"] = {
        "median": statistics.median(totals),
        "min": min(totals),
        "max": max(totals),
    }
    with open(args.out, "w") as handle:
        json.dump(report, handle, indent=1)
    print(json.dumps(report["totals_kb"]))


if __name__ == "__main__":
    sys.exit(main())
