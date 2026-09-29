#!/usr/bin/env python3
"""A02 idle baseline sampler: launches the release binary against an
isolated HOME and a fixture repo, samples the whole process tree from
/proc, and prints averaged CPU share and RSS. No AT-SPI, no network."""
import json
import os
import shutil
import subprocess
import sys
import time

binary, repo, out = sys.argv[1], sys.argv[2], sys.argv[3]
seconds = float(sys.argv[4]) if len(sys.argv) > 4 else 60.0

home = out + ".home"
shutil.rmtree(home, ignore_errors=True)
for sub in (".config", ".cache", "runtime"):
    os.makedirs(os.path.join(home, sub), exist_ok=True)
config = os.path.join(home, ".config", "dev.guit.desktop")
os.makedirs(config, exist_ok=True)
with open(os.path.join(config, "session.json"), "w", encoding="utf-8") as handle:
    json.dump({"schema_version": 1, "path": os.path.abspath(repo)}, handle)

env = dict(os.environ)
env.update(
    HOME=home,
    XDG_CONFIG_HOME=os.path.join(home, ".config"),
    XDG_CACHE_HOME=os.path.join(home, ".cache"),
    XDG_RUNTIME_DIR=os.path.join(home, "runtime"),
    GUIT_PERF="1",
)
log = open(out + ".app.log", "w", encoding="utf-8")
t0 = time.monotonic()
proc = subprocess.Popen([binary], env=env, stdout=log, stderr=log, start_new_session=True)

hertz = os.sysconf("SC_CLK_TCK")
page_kb = os.sysconf("SC_PAGE_SIZE") // 1024
num_cpus = os.cpu_count() or 1


def tree(root_pid):
    children = {}
    stats = {}
    for pid_dir in os.listdir("/proc"):
        if not pid_dir.isdigit():
            continue
        try:
            with open(f"/proc/{pid_dir}/stat", encoding="utf-8") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
            ppid = int(fields[1])
            utime = int(fields[11])
            stime = int(fields[12])
            comm = ""
            with open(f"/proc/{pid_dir}/status", encoding="utf-8") as handle:
                rss_kb = 0
                for line in handle:
                    if line.startswith("VmRSS:"):
                        rss_kb = int(line.split()[1])
                    elif line.startswith("Name:"):
                        comm = line.split("\t", 1)[1].strip()
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError, ValueError):
            continue
        children.setdefault(ppid, []).append(int(pid_dir))
        stats[int(pid_dir)] = (comm, utime + stime, rss_kb)
    seen, stack = set(), [root_pid]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        stack.extend(children.get(pid, []))
    rows = []
    for pid in seen:
        if pid in stats:
            comm, ticks, rss_kb = stats[pid]
            rows.append((pid, comm, ticks, rss_kb))
    return rows


samples = []
while time.monotonic() - t0 < seconds:
    rows = tree(proc.pid)
    total_ticks = sum(row[2] for row in rows)
    total_rss_kb = sum(row[3] for row in rows)
    webkit_rss_kb = sum(row[3] for row in rows if "WebKit" in row[1])
    git_children = sorted({row[1] for row in rows if row[1] == "git"})
    samples.append((time.monotonic(), total_ticks, total_rss_kb, webkit_rss_kb, git_children, list(rows)))
    time.sleep(1.0)

alive = proc.poll() is None
first = samples[0]
last = samples[-1]
tick_delta = last[1] - first[1]
window = last[0] - first[0]
cpu_pct = 100.0 * (tick_delta / hertz) / window / num_cpus
result = {
    "label": "a02-idle-baseline",
    "seconds": window,
    "alive_at_end": alive,
    "process_tree_cpu_percent_of_all_cores": round(cpu_pct, 4),    "single_core_equivalent_percent": round(cpu_pct * num_cpus, 2),
    "peak_rss_mib": round(max(s[2] for s in samples) / 1024, 1),
    "final_rss_mib": round(last[2] / 1024, 1),
    "final_webkit_rss_mib": round(last[3] / 1024, 1),
    "final_tree": [
        {"comm": row[1], "rss_mib": round(row[3] / 1024, 1)}
        for row in sorted(last[5], key=lambda r: (r[1], r[0]))
    ],
    "git_children_seen": sorted({name for s in samples for name in s[4]}),
    "sample_count": len(samples),
    "hosts_logical_cpus": num_cpus,
}
with open(out, "w", encoding="utf-8") as handle:
    json.dump(result, handle, indent=2)
print(json.dumps(result, indent=2))
if alive:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        subprocess.run(["pkill", "-TERM", "-P", str(proc.pid)], check=False)
        proc.kill()
log.close()
shutil.rmtree(home, ignore_errors=True)
