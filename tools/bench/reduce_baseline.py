#!/usr/bin/python3
"""Reduce tools/bench full per-run records into median/min/max tables.

Usage: reduce_baseline.py <record.json> [<record.json> ...]

Pass the full per-run files (``*.NAME.MODE.N.json`` written next to the
results jsonl by run_matrix.sh); they carry ``perf_records`` that the summary
jsonl lines omit. Cells and modes are parsed from the run label
``<cell>-<cold|warm>-r<run>``.
"""

import glob
import json
import re
import statistics
import sys

METRICS = [
    ("landmark_l1_s", "L1 first frame (s)"),
    ("landmark_l2_s", "L2 interactive (s)"),
    ("refresh_visible_latency_s", "dirty->visible (s)"),
    ("inotify_watches", "inotify watches"),
    ("idle_rss_kb_median", "idle RSS med (KB)"),
    ("idle_rss_kb_max", "idle RSS max (KB)"),
    ("idle_cpu_cores_avg", "idle CPU (cores)"),
    ("hwm_kb_peak", "peak RSS (KB)"),
    ("main_hwm_kb", "main-process HWM (KB)"),
    ("wall_s", "wall (s)"),
]

LABEL_RE = re.compile(r"^(?P<cell>.+)-(?P<mode>cold|warmed|warm)-r(?P<run>\d+)$")


def stat(series):
    return statistics.median(series), min(series), max(series)


def main():
    paths = []
    for pattern in sys.argv[1:]:
        if pattern.endswith(".jsonl"):
            paths.extend(sorted(glob.glob(pattern + ".*.json")))
        else:
            paths.extend(sorted(glob.glob(pattern)))

    groups = {}
    for path in paths:
        with open(path) as handle:
            record = json.load(handle)
        match = LABEL_RE.match(record.get("label", ""))
        cell = match.group("cell") if match else record.get("label", "?")
        mode = match.group("mode") if match else "?"
        groups.setdefault((cell, mode), []).append(record)

    for (cell, mode), rows in sorted(groups.items()):
        print(f"\n## {cell} / {mode} (n={len(rows)})")
        for field, name in METRICS:
            series = [r[field] for r in rows if r.get(field) is not None]
            if not series:
                continue
            med, lo, hi = stat(series)
            print(f"{name:22s} med={med:9.3f} min={lo:9.3f} max={hi:9.3f}")
        perf = {}
        pages = [t for r in rows for t in (r.get("history_page_latencies_s") or [])]
        if pages:
            med, lo, hi = stat(pages)
            print(
                f"{'page load (s)':22s} med={med:9.3f} min={lo:9.3f} max={hi:9.3f} "
                f"(n={len(pages)} page clicks)"
            )
        for row in rows:
            for entry in row.get("perf_records", []):
                perf.setdefault(entry["phase"], []).append(entry["ms"])
        for phase, series in sorted(
            perf.items(), key=lambda kv: -statistics.median(kv[1])
        )[:10]:
            med, lo, hi = stat(series)
            print(f"  perf {phase:26s} med={med:8.1f} min={lo:8.1f} max={hi:8.1f} (n={len(series)})")


if __name__ == "__main__":
    main()
