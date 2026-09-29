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

guit performs no network operation, so there is no credential path to verify:
no askpass bridge, no password prompt, no authentication retry (see
`docs/credentials.md`). SSH passphrase prompting does not exist either — there
is nothing for it to unblock.

Continuous integration is configured (`.github/workflows/`) for per-platform
bundles. No CI pass has been confirmed; none should be inferred from the
workflow files being present.

## Manual gates still open

These need a human and a second machine, and are honestly outstanding:

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
- The working-tree file listing (`git ls-files --cached --others
  --exclude-standard`) is capped at the same 32 MB, for the same reason: one
  record per file, so it grows with file count. Past the cap it is reported as
  **no answer at all**, never as a partial one. The two halves of that listing
  come back in order — one category, then the other — so the prefix that
  survives is biased toward whichever category was listed first, and the file
  it drops may be the newest one in the tree.
- Extremely large repositories may therefore surface "output too large"
  errors instead of partial listings; manual refresh is always offered.

## Long operations

- Every operation guit can start is local, and every local operation is bounded
  by **duration** — minutes for the write lane. The one case that used to be
  decided by silence instead, a clone that stops reporting, no longer exists:
  a stalled transfer is not a state the panel can reach.
- The local-only enforcement itself — `submodule.recurse` forced off and lazy
  object fetching disabled for every `git` guit runs — **has not been exercised
  against a partial clone or a repository with a real submodule**. It is built
  to fail closed: if Git refuses something because of those controls, the panel
  reports a read or write failure rather than a clean repository. That refusal
  shape has not been observed on a fixture yet. The guard is also only as old as
  the variable that carries it: a Git that does not know `GIT_NO_LAZY_FETCH`
  ignores it rather than refusing, so the bound that is actually verified is the
  Git 2.53 this project is built against.

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
  WebKitGTK exposes no EditableText). Typed-input flows (creating and renaming
  a branch, naming a tag, writing a commit message) are covered by Rust-side
  tests but were not clicked-through end-to-end with real typing.

## The last-modification line

- The candidates are exactly the files Git names: tracked files, plus untracked
  ones Git has not been told to ignore. A file matched by `.gitignore`,
  `.git/info/exclude` or `core.excludesFile` therefore **never moves the age**,
  and neither does anything inside a nested repository — Git lists that as one
  entry, not as its contents, so a build directory you ignore can be rewritten a
  thousand times while the line stays where it was. That is Git's own definition
  of the working tree, not a gap in the timer.
- The age is recomputed by the panel's own timer from the value the backend last
  pushed, so what it shows is always up to one interval behind the clock, and
  between two pushes the named file can be older than the tree. A tick never
  reads Git: the line moving is not evidence that anything was re-checked, and a
  quiet repository costs nothing to keep on screen.
- The interval is a **display** setting only, between 1 and 60 seconds (default
  5), in Settings → General. It is unrelated to the watcher's own debounce and
  fallback poll interval, which decide when a *measurement* arrives, not when the
  text is repainted: sixty seconds here never leaves the file list sixty seconds
  stale, and one second never costs a Git read per second. Setting it is not a
  way to make guit watch more closely, and a value outside the range is corrected
  to the bound rather than trusted.
- The interval is stored in the panel's own local preferences, so it is per
  window on this machine and it is not part of the diagnostic export. If storage
  refuses the write — private mode, a full quota — the value still applies for
  the session, the row says it could not save it, and the next start returns to
  whatever storage holds.
- There is no "scanning" state on the wire. Between a session opening and the
  first measurement for it — and after a failed refresh clears one — the line
  reads `Last modification unknown` rather than keeping the previous
  repository's number, and a partial listing says `at least` instead of a time.
- The file named beside the age is a lossy rendering of the path's bytes, kept
  for reading only: a name that is not valid UTF-8 shows replacement characters,
  and nothing can turn what is displayed back into a path.

## Deliberate refusals

- guit shows no file contents, diffs, or editor. Diffs, conflict resolution
  and file opening always leave for external tools
  (see `docs/external-tools.md`).
- Failures enter a toast stack (top-right, up to four, each with its own close
  button), so a second failure does not replace the first and a watcher
  refresh cannot hide it.
- Destructive operations are only possible through the
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
- guit refuses to be a remote client. Clone, fetch, pull, push, force push,
  publishing and remote administration have no entry point, no registered
  command and no background task, so a request that names one cannot reach the
  process layer at all — not even by calling the retired IPC by hand.
- A Git read that exits `0` while writing to stderr is treated as an
  **incomplete** read: the snapshot is not published and a write recheck is
  refused, rather than the panel showing whatever part of the tree Git managed
  to open. Only whether stderr is empty is used — the text follows Git's locale
  and version, and the warning that matters here has no `warning:` prefix to
  key on. The shapes a panel actually meets — unborn, clean, staged, modified,
  untracked, deleted, renamed, conflicted, detached, and a repository holding a
  nested repository — are pinned by a test as producing an empty stderr, so the
  refusal almost never fires. It has **not** been exercised against
  `core.fsmonitor`, which is the everyday setting most likely to make a healthy
  repository write to stderr on a successful read; if it does, this release
  reports that repository as unreadable instead of reading it partially.

## The custom theme

- A pasted fragment may say colours and font families, on the panel's own parts.
  Everything else is refused, declaration by declaration, and each refusal is named.
  Custom properties stay open on purpose, so hiding a control needs no refused
  declaration — which is why the panel looks at the screen *after* drawing instead of
  trusting the review to have predicted it.
- What that look checks is whether the controls that turn a theme off still have a box.
  A fragment that leaves the box and paints it the colour behind it, or moves it off the
  window, is not caught as a failure. The key press is still the promise in either case:
  it is listened for on the window, before the page exists and where no stylesheet
  reaches.
- The ask to start without themes is a session value, so it names one window. Closing
  that window and opening another is an ordinary start, drawing whatever the record says
  to draw.
- The subset is pinned against WebKitGTK 2.52.6, the engine guit draws through. Other
  engines have never been run (see **Platform coverage**), so a value one engine reads
  and another refuses is a difference nobody has measured — and a fragment stored from
  this engine is re-reviewed, not replayed, on every start.

## The window controls

- The four app-bar actions are a second way onto the native title bar's own four, not a
  replacement for them: the decoration stays on, and the page has no drag region. What
  has been run is the decoration this host gives — GTK 3 through XWayland. A window
  manager that draws no decoration at all is the case where these buttons are the only
  way to minimise or close guit, and it has never been measured here. Windows and macOS
  have never been run at all (see **Platform coverage**).
- The buttons report the desktop's *answer*. What is not claimed is that the answer is
  the visible result: a window manager that ignores an always-on-top request, or a
  compositor that re-stacks the window the moment it is placed, leaves the control
  agreeing with what the window was told. Nothing re-reads the stack.
- Their reachability at 340 px is asserted by accessible name through the narrow-window
  harness, which is a claim about the accessibility tree, not about paint. Whether a
  pointer actually lands on a nine-millimetre box is a rendering fact that harness
  cannot see, and hit-testing has not been measured on a touchscreen.
- The cluster is **not** one of the controls a custom theme is checked against after it
  draws (see **The custom theme**). A fragment that hides only the window cluster is
  therefore not caught, and is not a failure the panel reports: the way out of a theme
  runs through the tabs and the Settings rows, both of which are watched, and the key
  press reaches the window itself.
- Closing the window writes the geometry and the panel's choices down before the window
  is gone. What it does not do is reap a Git process that was still running: an
  operation in flight at exit leaves its process group behind. A *cancelled* operation
  kills the group; nothing kills it on the way out of the application.
- Multi-display clamping of a restored window is unverified (see **Manual gates still
  open**): the verification host is single-display, so the round trip through a scale
  change or a second monitor is a claim the stored fields support but no run has shown.

## Objects that are not here

A partial clone or a repository whose objects were pruned may be missing objects
that a view would like to read. guit does not fetch them: the read fails, the
failure is reported as a failure, and the repository is not presented as clean
or as complete. Fetching those objects is something you do in a terminal.
