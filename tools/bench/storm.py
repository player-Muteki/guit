#!/usr/bin/python3
"""Touch files in a fixture repo in bursts to exercise the watcher debounce and
the refresh coalescing gate (M6-02).

Usage: storm.py <repo> <files> <bursts> [burst-interval-s]

Each burst rewrites <files> tracked working-tree files (append one byte);
bursts are spaced by <burst-interval-s> (default 0.05 s). The app-side effect
(refresh counts per burst) is read from the GUIT_PERF log, not from here.
"""

import glob
import os
import random
import sys
import time


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    repo = sys.argv[1]
    wanted = int(sys.argv[2])
    bursts = int(sys.argv[3])
    interval = float(sys.argv[4]) if len(sys.argv) > 4 else 0.05

    candidates = sorted(
        p for p in glob.glob(os.path.join(repo, "src", "**", "*"), recursive=True)
        if os.path.isfile(p)
    )
    if not candidates:
        print("no files to touch", file=sys.stderr)
        return 1
    random.seed(20260925)
    for _ in range(bursts):
        for path in random.sample(candidates, min(wanted, len(candidates))):
            with open(path, "ab") as handle:
                handle.write(b"storm\n")
        time.sleep(interval)
    print(f"storm done: {bursts} bursts x {wanted} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
