# M6 verification record

## Environment observed on 2026-09-25

Ubuntu 26.04.1 LTS (resolute), Linux x86_64 kernel 7.0.0-34-generic, GNOME Wayland (XWayland, HiDPI scale 2), Intel Core i9-14900HX (32 threads), 14 GiB RAM, storage YMTC NVMe (rotational=false, ext4). rustc/Cargo 1.96.1, Node 26, Git 2.53.0, Tauri crate 2.11.6, WebKitGTK 2.52.6 / GTK 3.24.52. Virus scanning: not applicable on this host. All runtime and measurement evidence below is from this single Linux host; nothing here validates Windows or macOS.

Measurement caveat (pre-registered deviation from `plan/07`): `/tmp` is tmpfs on this machine, so the "cold" column means application-cold start with freshly created fixtures — it is **not** disk-page-cache-cold. Without root, caches cannot be dropped; the honest two columns are therefore "fixture freshly regenerated (cold app start)" and "repeat on warm pages (warm)".

## M6-01 baseline method

- Instrumentation: `perf.rs` gated by `GUIT_PERF=1`, emitting `[perf] phase=<label> ms=<float>` on stderr only. Labels are phase names only — never paths, arguments, URLs or output. With the gate off the cost is a single cached atomic read.
- External harness (authoritative for product metrics, never packaged): `tools/bench/`
  - `make-repo.sh <dir> <tracked> <untracked> [dirty]` — idempotent fixture generator, ~1.2 KB files, flat+nested mix, Chinese/space file names, isolated `-c` identities, 10% dirty tail.
  - `make-history.py <dir> <commits>` — `git fast-import` generator (measured quirks of Git 2.53: `M 644` requires the space after `M`; `committer` and message `data` must precede the `from` parent line; in-stream parents use commit marks because `refs/heads/main^0` does not resolve for a branch created in the same stream).
  - `bench_run.py` — one protocolized run: isolated HOME/XDG dirs seeded with `session.json`, `GUIT_PERF=1`, spawn release binary, 100 ms process-tree RSS/CPU sampler from `/proc` (tree = full PID subtree; includes WebKitGTK helper processes by necessity), 20 ms landmark poll over AT-SPI, optional `--touch` refresh-latency measurement, optional `--history-pages` clicks, inotify watch count via `/proc/<pid>/fd` readlinks, clean `killpg` teardown.
  - `atspi_landmark.py` — shared AT-SPI helpers. L1 = `Changes` card text present; L2 = `Monitor:` line AND history ready line (`N commit(s)` / `No commits yet`) — i.e. restore, recent list and watcher announcement all landed. Measured: the WebKit accessibility tree materializes in one burst, so L1 and L2 timestamps coincide within the 20 ms poll granularity; this is recorded as a method bound (±50 ms), not a defect.
  - `run_matrix.sh` / `reduce_baseline.py` — sweep and median/extremes reducer. Repeat protocol: run 1 per cell recreates the fixture (cold), runs 2–5 reuse the warm tree.
- Reference comparison: `vscode_ref.py` samples the `/usr/bin/code` process tree (main/renderer/gpu/utility/extensionHost classified from cmdline) on the same 10k fixture with an empty `--extensions-dir` (built-in git provider only). Scope-limited per `plan/07`: a full editor is not equivalent to a single-purpose client; this is a reference measurement only.

## M6-01 baseline results

Protocol: 4 cells × 5 runs (run 1 = fixture freshly regenerated, "cold"; runs 2–4/5 reuse the warm tree, "warmed"). Every value is median with min–max extremes; `n` counts repeats (or clicks). RSS is the whole process tree (guit main + WebKitGTK helpers), sampled at 100 ms from `/proc`. Fixtures: `tiny` = 1 tracked file, `100`/`1k`/`10k` = that many tracked files with a 10% dirty tail (100 has 10 dirty, 1k has 100, 10k has 1000); all cells have 0 untracked at this stage (the untracked sweep is M6-02).

| cell / mode | n | L2 interactive s | dirty→visible s | inotify watches | idle RSS med KB | idle CPU cores | peak RSS KB | main HWM KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tiny cold | 1 | 1.053 | 0.327 | 19 | 469,028 | 0.078 | 475,824 | 213,328 |
| tiny warmed | 4 | 0.989 (0.488–1.053) | 0.347 (0.301–0.402) | 19 | 469,106 | 0.075 (0.075–0.082) | 475,262 (474,728–476,912) | 213,614 |
| 100 cold | 1 | 1.012 | 0.336 | 20 | 469,340 | 0.077 | 474,612 | 213,736 |
| 100 warmed | 4 | 0.999 (0.993–1.022) | 0.341 (0.334–0.346) | 20 | 469,210 | 0.077 (0.075–0.079) | 475,614 (474,128–484,224) | 213,550 |
| 1k cold | 1 | 1.025 | 0.373 | 38 | 469,928 | 0.076 | 477,288 | 215,224 |
| 1k warmed | 4 | 1.013 (1.002–1.058) | 0.370 (0.360–0.394) | 38 | 470,282 | 0.076 (0.075–0.077) | 476,410 (475,076–481,376) | 214,666 |
| 10k cold | 1 | 1.028 | 0.360 | 197 | 470,288 | 0.076 | 478,636 | 212,812 |
| 10k warmed | 4 | 1.025 (0.574–1.032) | 0.317 (0.306–0.333) | 197 | 470,274 | 0.079 (0.075–0.079) | 480,966 (477,648–482,268) | 214,058 |
| hist200 cold | 1 | 1.115 | — | — | — | — | — | — |
| hist200 warmed | 4 | 1.039 (0.520–1.139) | — | — | — | — | — | — |

History paging (hist200, PAGE_SIZE=50, "Load older" click → row-count settle, wall seconds per page): cold median 0.073 (0.065–0.082, n=3 clicks); warmed median 0.129 (0.060–0.416, n=12). One cold run registered only 3 of 4 clicks (button state raced the settle check). L1 and L2 timestamps coincide (±20 ms poll granularity) because the WebKit AT tree materializes in one burst — recorded as a method bound, not a defect. Outlier note: some warmed L1/L2 minima (0.44–0.57 s) sit below any other run; either genuine warm-page-cache starts or residual AT-SPI matches — medians (≈1.0 s) are treated as the trustworthy column.

### Per-phase timings (`GUIT_PERF`, ms)

| phase | tiny | 100 | 1k | 10k | notes |
| --- | --- | --- | --- | --- | --- |
| `detect.total` (5 rev-parse spawns) | 25.9–47.3 | 25.6–26.2 | 25.9–46.8 | 25.9–46.5 | flat vs repo size: spawn-bound |
| `startup.restore_total` | 27.4–74.3 | 28.0–68.7 | 32.9–113.7 | 32.9–113.7 | detect + status + history + refs |
| `capture.total` (status+parse+inflight) | 2.2 (min 1.6) | 2.3 (min 1.5) | 23.7 (min 2.7) | 7.6 (min 5.3) | 10k tracked files ≈ 8 ms — Git status itself is cheap |
| `git.status` | ~2.2 | ~2.3 | ~23.5 | ~7.4 | distribution is bimodal, see below |
| simple plumbing spawns (`git.config`, `git.remote`, `git.stash`) | 21.4–21.6 med | same | same | same | min ≈ 20.8–21.0, rare min 1.2–2.7 |
| `git.log` first page | 24.5–32.6 | 28.3 | 12.0–32.4 | 12.0–17.1 | 1 commit fixtures |
| `startup.restore_at` (ms since process start) | 870–940 | 856–928 | 885–928 | 451–926 | dominated by WebKit window init, not Git |

Key measured findings (inputs to M6-02/03, deliberately not yet "fixed"):

1. **Runner polling floor.** Simple Git commands show a ~21 ms median with occasional 1–3 ms minima — the shape of `runner::run_with_limit`'s 20 ms `recv_timeout`/sleep granularity, not real Git cost. Every command pays up to one 20–40 ms round; a heartbeat refresh chain (`git.status` + `git.stash` + `git.remote` + 2×`git.config` + `git.ls-files`/`git.for-each-ref`) therefore serializes ~100+ ms per visible refresh even though the repository work is single-digit ms.
2. **Idle refresh rate ≈ 3.1 captures/s** (n≈96 per 31 s run) — above the 1 s heartbeat alone, so heartbeat plus other re-read paths (front-end card reloads republishing invokes) drive idle work; idle CPU stays ≈ 0.076 cores, honest but non-zero.
3. **Status capture scales sub-linearly**: 100→10k tracked files moves `capture.total` median from 2.3 ms to 7.6 ms. The `plan/02` large-repo untracked-scan contingency is not triggered by tracked-file size; the M6-02 untracked sweep decides it.
4. **Memory floor is WebKit, not guit**: main-process HWM ≈ 213 MB; the ~470 MB tree figure is dominated by renderer/GPU helper processes. Low-resource claims must be stated with this breakdown (threshold freeze deferred to M6-07 per plan decision 13).
5. **Detect costs 5 spawns** (`detect.total` ≈ 25–47 ms) — the plan decision-6 candidate (merge into one multi-flag `rev-parse`) now has its measured trigger (open-path spawn overhead > 25 ms).

## M6-01 gates and reproduction

- `cargo test --locked`: 274 unit (272 existing + 2 `perf::tests`) + 5 integration `askpass_e2e` pass. `npm run test:fixture`: 9 pass. `npm run build` (tsc + vite) passes. `cargo fmt --check`, `git diff --check` pass. `cargo clippy --locked --all-targets`: the same 12 pre-existing warnings in `branches/clone/main/network/remotes/status/tags/worktrees/write`; zero from M6 code.
- `npm run tauri build -- --bundles deb,rpm`: exit 0, zero compiler warnings, guit_0.1.0_amd64.deb 4,193,546 B, guit-0.1.0-1.x86_64.rpm 4,194,482 B (bench + all measurements used this bundle-built binary; plain `cargo build --release` binaries load the dev URL and are unusable — recorded as a build-method fact).
- Saved reproduction commands (raw records kept under `/tmp/guit-m6-baseline.jsonl*`, `/tmp/guit-m6-paging.jsonl*`, `/tmp/guit-m6-vscode-ref.json`; fixtures are regenerable):

```sh
bash tools/bench/make-repo.sh /tmp/guit-m6-bench/<cell> <tracked> <untracked> <dirty>   # per cell
bash tools/bench/run_matrix.sh app/src-tauri/target/release/guit 5 /tmp/guit-m6-baseline.jsonl
bash tools/bench/paging_supplement.sh app/src-tauri/target/release/guit 5 /tmp/guit-m6-paging.jsonl
/usr/bin/python3 tools/bench/reduce_baseline.py /tmp/guit-m6-baseline.jsonl /tmp/guit-m6-paging.jsonl
```

## M6-01 VS Code reference (bounded, 10k fixture)

`vscode_ref.py` one run set on the same `/tmp/guit-m6-bench/10k` tree, isolated `--user-data-dir`, empty `--extensions-dir` (built-in provider only), 20 s warm-up + 30 s sampling at 200 ms (149 samples), classification from `/proc` cmdlines:

| tree component | median RSS | max |
| --- | --- | --- |
| main | 480,264 KB | 524,872 |
| renderer | 264,460 KB | 404,356 |
| gpu | 258,896 KB | 259,168 |
| utility services | 636,124 KB | 776,808 |
| zygote + other | 132,016 KB | 132,012 |
| **tree total** | **1,771,740 KB (≈1.69 GiB)** | 2,097,216 |

Reference reading (scope per `plan/07`: a full editor is not equivalent to a single-purpose client): guit's whole tree on the identical fixture is ≈460 MB median (main process only ≈213 MB) — roughly 3.8× less total RSS. Caveat recorded honestly: the sampler could not assert the SCM sidebar was actually rendered/activated (no UI probe), so provider-scan work may vary; treat as an idle-editor process-tree reference, not a feature-for-feature comparison.

## M6-02 large-repo matrix and policy verdicts

Tools added this subtask (all under `tools/bench/`, regenerable fixtures, nothing in the product): `sweep_untracked.sh` (6 cells tracked×untracked × 3 repeats), `make-history.py` fast-import 10,000-commit fixture, `deep_paging.sh` (raw timed `git log --skip N -n 50`, 5× per skip point, bash ms timing — deliberately outside the guit runner so the 20 ms receive floor is not mixed in), `storm.py` + `burst_measure.sh` (file-event bursts against a running binary with `GUIT_PERF`), `phase2_measures.sh` (serializes hist10k build → deep-page curve → in-app 60-click paging → burst test; all measurements run one at a time).

### Untracked scan sweep (`--untracked-files=all`, kept)

Capture cost per `status` refresh (median over the run; `capture.total` = spawn + parse + in-flight bookkeeping):

| cell | `capture.total` med (min) | `git.status` med | `capture.parse` med | idle tree RSS med | main HWM | inotify |
| --- | --- | --- | --- | --- | --- | --- |
| t100-u1k | 23.1 (2.6) | 22.6 | 0.1 | 485,848 KB | 215,032 | 21 |
| t100-u10k | 30.8 (8.9) | 27.2 | ~0.4 | 597,312 KB | 237,916 | 21 |
| t1k-u1k | 24.7 (3.7) | 24.1 | 0.1 | 485,556 KB | 215,916 | 39 |
| t1k-u10k | 32.3 (10.6) | 28.6 | ~0.5 | 596,924 KB | 239,120 | 39 |
| t10k-u1k | 24.0 (2.4) | 23.4 | 1.1 | 485,036 KB | 212,924 | 198 |
| t10k-u10k | 36.8 (13.1) | 33.8 | 1.1 | 597,576 KB | 237,612 | 199 |

Medians sit on the runner's ~21 ms spawn floor; minima show the real Git cost (a 10k×10k full sweep executes in ≈10–13 ms). **Verdict (decision 4): keep `all` as the default and do not implement the capped-depth/“Scan fully” fallback.** Evidence: worst cell p50 36.8 ms ≪ the 250 ms pre-registered trigger; parse is ≤1.1 ms of a 32 MB-capped capture (truncation-stays-an-error lane unchanged); RSS grows with the *untracked count only* — flat across tracked tiers (597 MB for every u10k cell), +24 MB main-process HWM for 9k extra paths — so growth is sub-linear in the product `tracked × untracked` that the contingency was sized for. The `plan/02` trigger bullet is annotated as measured-and-not-triggered; the "never silently omit files" rule stands untouched.

### Watcher and idle-refresh chain (decision 5)

Burst test on t10k-u10k: 6 bursts × 10 tracked files, 0.5 s apart, inside a ~11.5 s window → `watch.refresh` = 24, i.e. 2.1/s — at or *below* the ~3/s rate the untracked-sweep cells recorded with no storm at all (21–26 refreshes per ~8 s window). Marginal refreshes attributable to 60 file events: ≈ 0. Per-refresh latency during the storm held at 35–40 ms (`capture.total` for the cell), so the 250 ms debounce + leader/rerun coalescing gate already absorb bursts completely. **Verdict: no adaptive debounce, poll fallback unchanged.** The real cost driver is *idle*: ~2–3 captures/s, each chaining 5+ Git spawns (`git.stash`, `git.remote`, `git.config`×2, `git.ls-files`, `git.for-each-ref` — re-invoked per refresh by per-card pulls). That is handed to M6-03 as the "skip republish when the snapshot is identical / dedupe per-refresh spawns" candidate, with before-data = these sweeps' per-phase tables. inotify count is hard 199 watches on the 10k fixture, no `max_user_watches` pressure, no poll degradation observed at any point.

### Deep paging (decision 6② premise falsified; new frontend hotspot found)

Raw Git curve on the 10,000-commit fixture (`git log --skip N -n 50`, outside guit): skip 0 → 4–6 ms, 2500 → 11–13, 5000 → 16–19, 7500 → 19–24, 9950 → 26–27 ms. Linear, tiny, nowhere near the 200 ms trigger — **the rev-list OID-cursor cache is NOT implemented; its premise (`--skip` superlinearity) does not hold on Git 2.53 and the record stands as the refutation.** In-app, `git.log` stayed flat at med 45.8 ms (n=61, includes the floor) and `history.parse` at 0.1 ms, yet click-to-visible latency in the AT-SPI harness grew **super-linearly with the number of already-loaded rows**: clicks 1–10 med 129 ms → clicks 30–40 med 984 ms → clicks 51–60 med 1664 ms (max 1898). Root cause located in code, not Git: `renderHistoryRows()` (app/src/main.ts:1520) rebuilds and `replaceChildren()` the *entire* loaded list on every page append and on every commit selection — the History list, unlike Changes, is not virtualized, so per-click DOM/layout/AT work is O(loaded rows). Attribution caveat recorded honestly: the harness polls by walking the AT tree, whose size also grows with loaded rows, so part of the measured wall time may be observation rather than user-perceived latency; M6-03's incremental-render fix will be measured with the same harness before/after, which separates the two without changing methodology.

### M6-02 gates and reproduction

No product-code changes in this subtask (measurement + tooling only), so the Rust/TS suites from M6-01 apply unchanged. Reproduction:

```sh
bash tools/bench/sweep_untracked.sh app/src-tauri/target/release/guit 3 /tmp/guit-m6-untracked.jsonl
bash tools/bench/phase2_measures.sh app/src-tauri/target/release/guit   # hist10k + deep-page + 60-click + burst
/usr/bin/python3 tools/bench/reduce_baseline.py /tmp/guit-m6-untracked.jsonl /tmp/guit-m6-hist10k.jsonl
cat /tmp/guit-m6-deeppage.txt /tmp/guit-m6-burst.txt                    # raw curve and burst counts
```


