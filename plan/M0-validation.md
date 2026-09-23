# M0 verification record

## Environment observed on 2026-09-23

| Item | Observation |
| --- | --- |
| Host | Ubuntu 26.04 (resolute), Linux x86_64, kernel 7.0.0-31-generic |
| Desktop | GNOME on Wayland (XWayland also available), HiDPI scale factor 2, eDP 4096x2560 |
| Rust | `rustc`/Cargo 1.96.1 |
| Node/npm | Node 22.22.2, npm 10.9.7 |
| Git | 2.53.0 (`status --porcelain=v2 -z --branch` confirmed in isolated probe) |
| Tauri | CLI 2.11.5, `@tauri-apps/api` 2.11.1, tauri crate 2.11.6 |
| WebKitGTK | Development package installed; `pkg-config` reports 2.52.6 |
| GTK | Development package installed; `pkg-config` reports 3.24.52 |
| System opener | `/usr/bin/xdg-open` present |

## Completed checks (Linux host)

### Build and tests
- Project root initialized; initial documentation committed as `4fdfadf`.
- The npm 404 was caused by an incorrect package scope in the prototype (`@tauri-app` instead of `@tauri-apps`); manifest and imports corrected. `package-lock.json` and `Cargo.lock` are committed; CI uses `npm ci` / `cargo test --locked`.
- `npm run build` (tsc --noEmit + vite build) passes.
- `cargo test --locked` passes: 14 Rust unit/integration tests covering settings round-trip and corruption rejection, fit-window clamping with frame size and negative monitor origin, Git capability probing, redaction of URLs with userinfo/query, missing-git and unsupported-git error codes, 64KiB bounded output capture, cancellation of a running process, timeout killing a descendant that holds the pipes, and streamed `clone --progress` stderr.
- `npm run test:fixture` passes: 3 node:test suites over isolated temp repositories covering fixture isolation, `git difftool --trust-exit-code` (tool receives `$LOCAL`/`$REMOTE` contents for a Chinese/space filename, failure exit propagates, nonexistent tool fails, file content preserved) and `git mergetool` (conflict preserved on tool failure via `^u ` status, resolved on success verified with `ls-files --unmerged`, `mergetool.keepBackup=false`).
- `cargo fmt --check` and `git diff --check` pass.
- `npm run tauri build -- --bundles deb,rpm` produces guit_0.1.0_amd64.deb (≈3.1 MB) and .rpm. **AppImage is blocked**: the AppRun download from GitHub fails with a TLS connection drop on this network; this is a packaging-download issue, not a code issue.

### Runtime GUI verification (release binary, AT-SPI accessibility tree)
Screenshots were unavailable (GNOME screenshot DBus returned AccessDenied), so the running window was driven and observed through `/usr/bin/python3` + `gi.repository.Atspi` (`app/tests/desktop_probe.py`). Against the packaged release binary:
- Window starts at the saved settings, resizes, and enforces the 340x400 logical minimum.
- "Test compact window" shrinks to the minimum ("Viewport 340 × 400 logical…"), "Restore window size" returns to the previous size; maximize/unmaximize handled.
- "Always on top" toggles the checkbox and the window state; the checked state survives close + relaunch.
- Window settings persist to `~/.config/dev.guit.desktop/window.json` atomically; size is stable across close/relaunch cycles after switching from naive outer-size save to viewport-pixels (innerWidth × scaleFactor) + measured frame delta (a GNOME Wayland scale-2 quirk previously grew the window each restart).
- Folder picker (tauri-plugin-dialog) opened the native chooser and returned `/home/kys/code/guit/app`.
- "Run probe" reports "Git process completed and stdout was read."; "Run clone progress probe" streams `probe-progress` events to the UI without blocking it; cancellation path exercised via `--cancel-probe`.
- Missing/old Git produces structured redacted errors shown in the UI (verified via unit tests with fake git scripts; UI error rendering verified with an induced failure message).
- Close requests flush settings before destroy (`onCloseRequested` → preventDefault → save → destroy).

### External tools
- `xdg-open` path verified with `gnome-text-editor` on a file with a Chinese name (M0 scope: system default open works).
- difftool/mergetool behaviors verified in fixture tests, including the finding that `git difftool` ignores tool exit codes unless `--trust-exit-code` is passed — guit must pass that flag (or set `mergetool.<tool>.trustExitCode`) to detect failures.

### Source-review fixes found during verification
- Missing Vite port configuration; TypeScript `alwaysOnTop` vs Rust `always_on_top` serialization mismatch (fixed with `#[serde(rename_all = "camelCase")]`); window-size growth across restarts (fixed as above); "Restore window size" no-op while maximized (fixed with unmaximize-before-shrink and maximize-on-restore).

## Platform matrix

| Behavior | Linux host | Windows | macOS |
| --- | --- | --- | --- |
| WebView build/start | Verified (dev + release deb/rpm) | CI workflow prepared; not run | CI workflow prepared; not run |
| Git capability detection | Verified (unit + runtime) | CI unit tests pending | CI unit tests pending |
| Always on top / resize / restore | Verified via AT-SPI runtime | Runtime check pending | Runtime check pending |
| Git child cancellation / timeout | Verified (Rust tests incl. process-group kill) | Behavior pending | Behavior pending |
| External file/diff/merge tools | Verified (xdg-open + fixture tests) | Pending | Pending |
| Settings persistence across relaunch | Verified | Pending | Pending |

No three-platform claim is made: all runtime evidence above is from this single Linux host. Windows/macOS require the CI matrix run plus a manual runtime smoke check; compile success alone does not prove window behavior.

## Remaining gates (post-M0 handoff)

1. Run the GitHub Actions matrix (`.github/workflows/m0.yml`) and record results for Windows and macOS.
2. Resolve the AppImage AppRun download (network/proxy dependent) before M6 packaging claims.
3. Windows/macOS runtime smoke checklist lives in `M0-platform-setup.md`.
