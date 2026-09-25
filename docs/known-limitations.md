# Known limitations

Honest list as of v0.1.0 (2026-09-25). Everything below was **measured on
Linux**; "not verified" is stated explicitly where it applies.

## Platform coverage

- Linux (Ubuntu 26.04, GNOME Wayland): fully exercised — unit + integration
  tests, packaged deb/rpm, runtime click-through via AT-SPI.
- **Windows and macOS: build configuration only.** The release binary has
  not been run on either platform during this cycle; the platform matrix in
  `plan/M6-validation.md` lists every behavior as Pending.
- The interactive HTTPS askpass bridge is **unix-only by design**; on Windows
  credential retry is refused with guidance to use a `credential.helper`
  (see `docs/credentials.md`). SSH passphrase prompting is refused on all
  platforms — ssh-agent is the only supported path.

## Packaging

- The **AppImage** bundle was blocked by an M0-era network issue downloading
  its AppRun helper; the M6-04 retry produced it and it launched on the
  verification host (`APPIMAGE_EXTRACT_AND_RUN=1`, isolated HOME). No
  distribution beyond that host has been attempted. deb and rpm remain the
  primary Linux artifacts (`plan/M6-validation.md` §M6-04).
- Windows/macOS installers (NSIS/MSI, dmg) are configured but unbuilt this
  cycle.

## Output bounds (fail-closed, never silently wrong)

- `git status` output is capped at 32 MB; exceeding the cap is reported as an
  error (`git_status_truncated`) — a truncated parse is **never** presented
  as a clean repository.
- `git for-each-ref` (branches/tags list) and history page output are capped
  at 8 MB and refuse truncated input the same way.
- Extremely large repositories may therefore surface "output too large"
  errors instead of partial listings; manual refresh is always offered.

## Watching and responsiveness

- guit watches the working tree with inotify. If the kernel's
  `max_user_watches` limit is exhausted (very large trees or many open
  folders), the watcher **falls back to a 5-second poll** and says so in the
  monitor line — you never get silent staleness, but you may get up to 5 s
  latency in that mode.
- Keyboard injection into the packaged window could not be automated on this
  host (GNOME Wayland drops synthetic keys for unfocused XWayland windows;
  WebKitGTK exposes no EditableText). Typed-input flows (add remote, set
  URL, the credential dialog's submit leg) are covered by Rust-side tests
  but were not clicked-through end-to-end with real typing.

## Deliberate refusals

- guit shows no file contents, diffs, or editor. Diffs, conflict resolution
  and file opening always leave for external tools
  (see `docs/external-tools.md`).
- The window has one error alert slot: when several failures arrive in quick
  succession (e.g. two refused config files at boot), only the last is shown
  on screen. Nothing is lost — every failure also lands in the diagnostics
  ring and reaches the exported report.
- Force pushes and destructive operations are only possible through the
  preview → recheck → confirm ticket flow; tickets are single-use and die
  with the process (a restart cannot resurrect one).
- Configuration files with a future `schema_version` are refused, not
  migrated (no data is ever rewritten by an older guit). Config migration
  is **forward-roll by policy**: only a newer guit ever writes a newer
  schema; an older one leaves the bytes untouched and says so.
- Bare repositories open for inspection, but the status view is empty: Git
  itself refuses `status` in bare repositories, and guit reports that
  rather than inventing one.

## Authentication against real hosting providers

The credential dialog was verified end-to-end against a local 401 server
and via integration tests with real `git ls-remote`; **the manual pass
against GitHub/GitLab/Gitea accounts is a documented remaining gate**
(`plan/M6-validation.md`). Protected-branch refusals and provider-specific
SSO flows have not been exercised.
