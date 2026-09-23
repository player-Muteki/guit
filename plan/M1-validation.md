# M1 verification record

## Environment observed on 2026-09-23

| Item | Observation |
| --- | --- |
| Host | Ubuntu 26.04 (resolute), Linux x86_64, kernel 7.0.0-31-generic |
| Desktop | GNOME on Wayland (XWayland available), HiDPI scale factor 2, eDP 4096x2560 |
| Rust | `rustc`/Cargo 1.96.1 |
| Node/npm | Node 26 (type-stripping for `node --test`), npm bundled |
| Git | 2.53.0 |
| Tauri | CLI 2.11.5, `@tauri-apps/api` 2.11.1, tauri crate 2.11.6 |
| WebKitGTK / GTK | 2.52.6 / 3.24.52 |

## Build and automated tests (Linux host)

- `cargo test --locked`: 60 tests pass — repository discovery (7), porcelain v2 byte parsing against real Git output incl. conflicts, renames and non-UTF-8 paths, `PathTable` file-ID mapping, branch/upstream/ahead-behind capture from live repositories, snapshot versioning with coalescing and stale-publish guards (5), watcher debounce/poll-fallback/lifecycle with a real inotify smoke test (6), clone end-to-end (progress streaming, cancellation, occupied target, residue detection, redaction, name derivation; 6), plus the M0 probe/runner/settings regressions.
- `npm run test:fixture`: 9 node tests pass — 3 M0 git fixture suites plus 6 `fileModel` suites (group order/counts, collapse, bounded virtual window incl. a 50 000-file dataset, keyboard row movement and reveal-scroll).
- `npm run build` (`tsc --noEmit` + vite) passes with no type errors.
- `cargo fmt --check`, `git diff --check` pass.
- `npm run tauri build -- --bundles deb,rpm` produces guit_0.1.0_amd64.deb (≈3.4 MB) and .rpm with no compiler warnings. (AppImage remains blocked by the M0 network issue for AppRun download.)

## Runtime GUI verification (release binary, AT-SPI)

Driven and observed through `/usr/bin/python3` + `gi.repository.Atspi` against the packaged release binary, with disposable repositories under `/tmp/guit-m1-runtime` (isolated from the user's repositories):

- Session restore: a seeded `session.json` opened the repository at startup; the a11y tree showed `Branch: main`, the repository path, and `Monitor: filesystem events` (watcher active, not polling).
- Status list: groups rendered with counts — `▾ Staged changes (1)` (`M. a.txt`), `▾ Changes (1)` (`.M b 中文.txt`), `▾ Untracked files (1)` (`?? untracked.txt`) — proving porcelain v2 group mapping and Chinese/space filename display in the real UI.
- Watcher refresh without interaction: creating `watched.txt` in the working copy produced `Untracked files (2)` in the list within ~2 s with no clicks (event → debounce → refresh → `repo-refreshed` → version-guarded render).
- Clone card: renders source entry, `Into folder…`, `Clone` (correctly disabled before a destination is chosen) and `Cancel` (disabled while idle); `Into folder…` opened the native GTK chooser (`file chooser: 'Select Folder'`), and cancelling it left the UI in a clean state.
- `Test Git progress` (M0-06 regression): streamed `clone-progress`-style events into the UI and finished with `Local clone completed; 386 stderr bytes streamed; actual Git status is clean.` while the window stayed responsive.
- Responsive layout: `Test compact window` → `Restore window size` cycle executed; resize events reached the frontend (`Resized to 4096 × 2390 physical pixels` readout) and the button enable/disable states tracked the cycle. The narrow-layout CSS and virtual list were also exercised at 340×400 (M0 evidence pattern); group header collapse clicks verified via button actions.
- Window state: always-on-top checkbox persisted across restarts (M0 behavior re-observed unchanged); settings save-on-close path untouched by M1.

## Verification limitations on this host (honest gaps)

- **Keyboard navigation and shortcuts could not be injected at runtime.** GNOME Wayland drops XTEST synthetic key events for XWayland windows that do not hold compositor focus, and WebKitGTK does not expose the AT-SPI EditableText interface on the cloned entry. Arrow/Home/End navigation, Enter-collapse, Ctrl+R/O and font scaling are therefore verified by unit tests (`fileModel` node suites) and type-checked UI wiring, **not** by runtime key injection. A manual keyboard pass on a real desktop is a handoff gate.
- **Clone flow verified end-to-end only at the command layer.** The Rust tests run a real `git clone` (streaming, cancel, residue, detect, occupied-target refusal), and the UI gating/dialog/state machine is AT-SPI-verified as above, but a full click-through of source-typing + destination + Clone + auto-open was blocked by the keyboard limitation. The M0 disposable-clone probe confirms the same runner/event path renders progress in the UI.
- Filesystem watching used inotify on Linux; the poll-fallback path is covered by unit tests but was not exercised in the running app. macOS (FSEvents) and Windows (ReadDirectoryChangesW) behavior unverified.
- Single-platform claim: all runtime evidence above is from this one Linux host. Windows/macOS remain covered only by the prepared CI workflow (unit-test level).

## Platform matrix

| Behavior | Linux host | Windows | macOS |
| --- | --- | --- | --- |
| Repo/worktree/bare detection + status parse | Verified (unit + runtime UI) | Unit tests in CI pending | Unit tests in CI pending |
| Watcher auto-refresh in running app | Verified (inotify) | Pending | Pending |
| Virtual list incl. large datasets | Verified (model tests + runtime list) | Pending | Pending |
| Clone streaming/cancel/residue | Verified (Rust tests; UI gating partial, keyboard blocked) | Pending | Pending |
| Keyboard navigation / shortcuts | Unit tests only; runtime injection impossible on this host | Pending | Pending |
| Narrow layout + resize events | Verified (compact/restore cycle) | Pending | Pending |

## Remaining gates (post-M1 handoff)

1. Manual keyboard pass (arrows, Enter, Ctrl+R/O, font scaling) on a real desktop session.
2. Clone click-through with a real remote URL (credentials/SSH paths inherit the M0 auth caveats; guit never stores credentials).
3. Watcher smoke on macOS/Windows once CI matrix runs; verify poll fallback triggers there too.
