# Known limitations

Honest list for v0.0.1. Everything below was **measured on Linux**;
"not verified" is stated explicitly where it applies. Changes are recorded
in `CHANGELOG.md`.

## Platform coverage

All runtime evidence comes from a single Linux host (Ubuntu 26.04.1 LTS, GNOME
Wayland via XWayland, HiDPI scale 2, Git 2.53, WebKitGTK 2.52.6 / GTK 3.24.52,
rustc/Cargo 1.96, Node 26). Nothing in this project validates any other
platform.

| Platform | Status |
| --- | --- |
| **Linux** (x86_64) | **Verified.** Unit and integration tests, installed-package trial of the deb, and end-to-end click-throughs of every view, both dialogs and the diagnostics export. deb, rpm and AppImage all produced and launched. |
| **macOS** | **Build configuration only.** Bundle metadata (dmg/app, minimum system version 10.13) is schema- and config-validated. The app has never been run on macOS. Treat it as an untested preview. |
| **Windows** | **Build configuration only.** Bundle metadata (NSIS currentUser, MSI, WebView2 download bootstrapper) is schema- and config-validated. The app has never been run on Windows. Treat it as an untested preview. |

The interactive HTTPS askpass bridge is **unix-only by design**; on Windows a
credential retry is refused with guidance to use a `credential.helper`
(see `docs/credentials.md`). SSH passphrase prompting is refused on every
platform — ssh-agent is the only supported path.

Continuous integration is configured (`.github/workflows/`) for per-platform
bundles. No CI pass has been confirmed; none should be inferred from the
workflow files being present.

## Manual gates still open

These need a human and a second machine, and are honestly outstanding:

- The attended credential pass against real GitHub / GitLab / Gitea accounts.
- An interactive fetch killed mid-flight against a credential-protected
  remote, to confirm startup recovery removes the orphaned askpass directory
  and leaves the repository in its real state.
- The branch-delete ticket dialog killed mid-confirmation, to confirm a
  restart cannot resurrect the confirmation.
- Multi-display window clamping (the verification host is single-display;
  the clamp itself is unit-tested).
- Installing the packages on a distribution other than the verification host.

## Packaging

- **AppImage** is produced and launches on the verification host, but it needs
  `APPIMAGE_EXTRACT_AND_RUN=1` both to build and to run: `appimagetool` mounts
  its squashfs image through FUSE, which that host does not provide. Without
  the variable, `tauri build --bundles appimage` fails in `linuxdeploy`
  (Tauri's wrapper wording; the real blocker is the FUSE mount). Building it
  also needs network access to fetch the AppRun helper. deb and rpm are the
  primary Linux artifacts.
- Windows/macOS installers (NSIS/MSI, dmg) are configured but unbuilt.

## Output bounds (fail-closed, never silently wrong)

- `git status` output is capped at 32 MB; exceeding the cap is reported as an
  error (`git_status_truncated`) — a truncated parse is **never** presented
  as a clean repository.
- `git for-each-ref` (branches/tags list) and history page output are capped
  at 8 MB and refuse truncated input the same way.
- `git ls-files --stage` (the index listing the submodule view reads) is
  capped at 32 MB, the same bound as `git status`, because it grows with the
  repository's *file* count rather than with its submodule count. It used to
  share the 64 KB bound meant for one-shot tool output, so any repository of
  roughly a thousand files or more reported the submodule list as too large —
  including repositories with no submodules at all. The larger bound fixes
  that failure in this release.
- Extremely large repositories may therefore surface "output too large"
  errors instead of partial listings; manual refresh is always offered.

## Long operations

- A clone is bounded by **silence, not by duration**. Two minutes without any
  progress line from Git ends the attempt, and the report says guit stopped it
  rather than that you did — a transfer that stopped reporting cannot be
  revived by waiting. The cost of that choice is real: a server enumerating a
  very large repository can stay quiet for more than two minutes, and such a
  clone gets stopped even though it was only slow. Starting it again is the
  answer. Every other operation has a duration bound instead of a silence
  bound — one hour for fetch and push, minutes for the write lane — so a
  stalled clone is the one case guit decides by listening rather than by
  counting.

## Watching and responsiveness

- guit watches the working tree with inotify. If the kernel's
  `max_user_watches` limit is exhausted (very large trees or many open
  folders), the watcher **falls back to a 5-second poll** and says so in the
  monitor line — you never get silent staleness, but you may get up to 5 s
  latency in that mode.
- If a background status read fails, the monitor line reports the failed
  refresh and points to manual Refresh status. The indication clears after
  a successful refresh.
- Keyboard injection into the packaged window could not be automated on this
  host (GNOME Wayland drops synthetic keys for unfocused XWayland windows;
  WebKitGTK exposes no EditableText). Typed-input flows (add remote, set
  URL, the credential dialog's submit leg) are covered by Rust-side tests
  but were not clicked-through end-to-end with real typing.

## Deliberate refusals

- guit shows no file contents, diffs, or editor. Diffs, conflict resolution
  and file opening always leave for external tools
  (see `docs/external-tools.md`).
- Failures enter a toast stack (top-right, up to four, each with its own close
  button), so a second failure does not replace the first and a watcher
  refresh cannot hide it.
- Force pushes and destructive operations are only possible through the
  preview → recheck → confirm ticket flow; tickets are single-use and die
  with the process (a restart cannot resurrect one).
- Configuration files with a future `schema_version` are refused, not
  migrated (no data is ever rewritten by an older guit). Config migration
  is **forward-roll by policy**: only a newer guit ever writes a newer
  schema — upgrading an old file once and backing it up — while an older
  one refuses to read newer state and leaves the bytes untouched.
- Bare repositories open for inspection, but the status view is empty: Git
  itself refuses `status` in bare repositories, and guit reports that
  rather than inventing one.

## Authentication against real hosting providers

The credential dialog was verified end-to-end against a local 401 server
and via integration tests with real `git ls-remote`; **the manual pass
against GitHub/GitLab/Gitea accounts is a documented remaining gate** (see
"Manual gates still open" above). Protected-branch refusals and
provider-specific SSO flows have not been exercised.
