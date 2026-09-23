# M2 verification record

## Environment observed on 2026-09-23

Identical to M1 (see `M1-validation.md`): Ubuntu 26.04 (resolute), Linux x86_64 kernel 7.0.0-31, GNOME Wayland (XWayland, HiDPI scale 2), rustc/Cargo 1.96.1, Node 26, Git 2.53.0, Tauri crate 2.11.6, WebKitGTK 2.52.6 / GTK 3.24.52. All runtime evidence below is from this single Linux host.

## Build and automated tests

- `cargo test --locked`: 94 tests pass — the 60 M0/M1 tests plus the M2 write-path suites:
  - `write` (26): queue single-slot rejection (`write_queue_busy`), stale-snapshot gate, unknown/mixed FileId all-or-nothing refusal, non-ASCII/space paths byte-exact through `git add --`/`restore --`, unstage index-side-only on both-sides files, new-file unstage → untracked, batch stage + retired-ID death, commit via 0600 temp file (message never appears in serialized `OperationResult`), unborn HEAD, hook rejection, signing failure, amend, pre-Git cancellation still refreshing, discard preview→recheck→confirm round trip (worktree-side restore), candidate-drift refusal, nonce consumption/replay, untracked/conflict refusal, staged-only `dropped` list, clean candidate listing + exact-pathspec removal (ignored and dirty-tracked files survive), clean candidate-growth refusal, clean nonce and version gates.
  - `extools` (7): fake difftool success/nonzero-exit (Git 2.53 normalizes tool exit to fatal 128; first stderr line kept redacted), non-ASCII pathspec hit, no-HEAD staged-diff refusal, stale snapshot refusal, pre-cancel not reaching Git, tool-slot concurrent refusal (`tool_busy`), opener spawn success/failure.
  - `probe` additions: `restore` capability bit (Git ≥ 2.23) structured refusal on older versions.
- `npm run test:fixture`: 9 node tests pass (unchanged from M1; M2 added no frontend pure-model functions).
- `npm run build` (`tsc --noEmit` + vite) passes with no type errors; `cargo fmt --check` and `git diff --check` pass.
- `npm run tauri build -- --bundles deb,rpm` produces guit_0.1.0_amd64.deb (≈3.4 MB) and guit-0.1.0-1.x86_64.rpm with no compiler warnings (AppImage remains blocked by the M0 network issue for AppRun download).

## Runtime GUI verification (release binary, AT-SPI)

Driven through `/usr/bin/python3` + `gi.repository.Atspi` (`do_action` on named buttons, `Text.get_text` on the status paragraphs) against the packaged release binary, on a disposable fixture `/tmp/guit-m2-runtime/repo` (seeded `session.json` for startup restore; repo-local config `diff.tool=guitfake`, `difftool.guitfake.cmd='true'`; `a.txt` tracked-dirty, `b.txt` untracked):

- Session restore opened the fixture at startup: `Branch: main`, correct path, `Monitor: filesystem events`; groups rendered `▾ Changes (1)` `.M a.txt` and `▾ Untracked files (1)` `?? b.txt`, with row buttons (Stage/Unstage/Open/Diff/Discard) exposed as accessible buttons.
- Stage: click `Stage b.txt` → status bar `Staged 1 file(s).`, `▾ Staged changes (1)` group appears; `git status --porcelain=v2` shows `1 A. … b.txt`.
- Unstage: click `Unstage b.txt` → `Unstaged 1 file(s).`, back to `? b.txt` (new-file unstage-to-untracked observed live).
- External diff: click `Diff a.txt` → fake difftool spawned and exited → status `Diff tool closed.`; repository state re-read after tool exit with the list unchanged.
- Discard confirm flow: click `Discard a.txt` → inline `role=alertdialog` panel with the non-recoverable warning and candidate `a.txt`; click Confirm `Discard` → `Discarded work-tree changes in 1 file(s).` and the file content on disk reverted to the committed version (worktree side only). The panel survived ~1 minute and several intermediate refreshes; the one-time nonce confirmed exactly once from a second driver process.
- Commit gating: click `Commit` with an empty textarea → rejection rendered as `Commit message is empty.` with no Git run; the empty-branch is the only commit path clickable without keyboard input (see gaps).
- Watcher + clean: creating `c.txt` externally appeared as `?? c.txt` within ~2 s without interaction; click `Clean…` → preview panel (`These untracked files and folders will be deleted from disk…`) listing `c.txt` only (ignored files absent by design); click `Delete untracked` → `Removed 1 untracked item(s).`, `c.txt` gone from disk while the still-staged `b.txt` and the tracked file were untouched — proving pathspec-scoped clean at runtime.
- AT-SPI driver note: walking the tree while WebKitGTK rebuilds it can throw `The application no longer exists` on stale child references; this is a driver-side race (the app stayed healthy; retries on fresh roots succeed), worked around with per-child try/except in the probe.

## Verification limitations on this host (honest gaps)

- **Commit success path is not runtime-verified.** Keyboard injection remains impossible on this host (GNOME Wayland drops XTEST keys for unfocused XWayland windows; WebKitGTK exposes no EditableText), so a commit message cannot be typed into the textarea. Real `git commit -F` (message temp-file lifecycle, amend, hook rejection, signing failure, input preservation in the UI) is covered by the 7 Rust temporary-repository tests, and the UI was verified for the empty-message rejection and button enable/disable states only. A manual keyboard pass is a handoff gate.
- **Race-shaped rejections are unit-tested only**: `write_queue_busy`, stale-snapshot refusal, discard/clean candidate drift, nonce replay, `tool_busy` — deterministic in Rust tests, not reproducible by hand at AT-SPI speed.
- `Open <file>` (xdg-open) buttons render and are accessible, but real desktop file-opening was not clicked during the smoke (would spawn unpredictable desktop apps). macOS `open` and Windows `explorer.exe` branches unverified; Windows `write_path_unrepresentable` branch unverified.
- Git protocol limitation recorded in the backlog: filenames containing newlines cannot be reliably parsed from `git clean -nd` text output (clean rejects `-z`); parsing is fail-closed.
- Single-platform claim: all runtime evidence above is Linux. Windows/macOS stay at CI unit-test level, as in M1.

## Platform matrix

| Behavior | Linux host | Windows | macOS |
| --- | --- | --- | --- |
| Write queue, op IDs, double-submit refusal | Verified (unit; runtime via successful writes) | Pending | Pending |
| Stage/unstage incl. both-sides and new-file paths | Verified (unit + runtime clicks) | Pending | Pending |
| Batch stage / stage-all, stale-ID death | Verified (unit) | Pending | Pending |
| Commit message temp file, commit/amend, hook/signing failure | Unit (temp repo) only; UI typing blocked by keyboard gap | Pending | Pending |
| Discard preview→recheck→confirm | Verified (unit + runtime confirm flow) | Pending | Pending |
| Clean preview/execution consistency | Verified (unit + runtime confirm flow) | Pending | Pending |
| External difftool success/exit-code/stderr | Verified (unit fake tool + runtime fake tool) | Pending | Pending |
| Open via OS opener | Button rendered; xdg-open launch not clicked | Unverified | Unverified |
| Post-write/post-tool forced refresh | Verified (runtime status text + watcher evidence) | Pending | Pending |

## Remaining gates (post-M2 handoff)

1. Manual keyboard pass on a real desktop: type a commit message, exercise Commit/amend, Ctrl+Enter, and the M1 shortcut set.
2. Real hook-rejection and signing-failure experience in the UI (input preservation, retry) — logic is unit-verified.
3. Open-with-real-tool smoke (`xdg-open`, and once available, user-configured difftool) on each platform.
4. Windows/macOS runtime matrices (paths unrepresentable on Windows, macOS `open`, FSEvents-triggered refresh during writes).
