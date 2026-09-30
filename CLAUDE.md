# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

guit is a Tauri 2 + framework-free TypeScript desktop panel for monitoring and managing
local Git repositories. Its core workflow works offline. It drives the installed `git`
binary with the existing Git configuration; there is no second Git implementation and
no vendored library.

## Product authority and scope

**Read `OUTLINE.md` before product or architecture work.** It is the authoritative
product goal. `plan/README.md` indexes the current-state audit, technical design,
implementation roadmap and acceptance criteria. This file supplies implementation
constraints; an existing feature or an old README description does not override the
outline. Keep these documents consistent when changing scope.

The target is a small, persistent monitoring panel with exactly two top-level tabs:
Main and Settings. Main shows search and latest-file-modification age above a changes
area and a current-branch commit graph, visible together. Preserve the required
staging, commit and previewed clean-reset flows, branch switching, commit tooltips,
fonts/theme CSS, configurable timer and four window controls. Do not recreate the
seven-view Git management suite behind an advanced-settings page.

**Local repositories only; core functionality must work without a network.** Open
repositories that already exist on disk. Do not add or retain product entry points,
background tasks or frontend-callable commands for clone, fetch, pull, push, force
push, publishing, remote administration or remote credential prompts. Submodule
downloads and implicit object fetching in partial clones are also outside scope.
Existing remote-tracking refs may be read as local metadata; do not claim they are
current remote state. Preserve the repository's own remote and credential settings.
Hooks, signing programs and external tools retain their existing Git configuration;
offline functionality is not an OS-level network sandbox for those programs.

The remote surface has left the source: no view, command registration or
background task for it remains. What still lingers is view code from the
seven-view suite that no page reaches. That is migration work, not evidence that
it belongs in the target product. Remove unused internals
without breaking shared local services. The plan describes future work; do not claim
it is implemented just because its documents exist.

Latest modification means the maximum filesystem mtime among eligible existing
working-tree files, not the last watcher event, refresh or commit. A clean reset must
account for target-tree changes and affected untracked paths, preserve protected
boundaries, and report partial execution honestly. Reuse the snapshot, runner and
single-use ticket boundaries below; do not implement these semantics in the frontend.

**The defining constraint: guit never displays file contents or diffs.** Opening a file,
viewing a diff and resolving a conflict all leave for `git difftool`, `git mergetool` and
the system opener. There is no content type in `app/src/types.ts` and no code path that
puts one in the DOM. Do not add one. If a change seems to need file contents in the
window, it needs a different design.

All user-facing text in this repo is unusually deliberate — see "Shipped text is a
contract" below before writing any string.

## Commands

Everything runs from `app/` (or use the root-relative `--manifest-path app/src-tauri/Cargo.toml`).

```sh
npm run tauri dev              # full app with hot reload (Vite on 127.0.0.1:1420)
npm run build                  # tsc --noEmit && vite build
npm run test:fixture           # node --test tests/*.mjs
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets
npm run bin:release            # release binary that actually runs standalone
```

**`npm run bin:release` is not the same as `cargo build --release`.** Without
`--features custom-protocol` the binary points its webview at the Vite dev server and
only works next to it. Anything meant to be launched outside `tauri dev` must go through
`npm run bin:release`.

Running one test:

```sh
node --test tests/file-model.mjs                        # one file
node --test --test-name-pattern="stale" tests/state.mjs # one test
cargo test --manifest-path src-tauri/Cargo.toml session  # substring filter
```

Two stylesheet gates, both pure-stdlib Python, both must run **after** `npm run build`
because they read the *built* bundle in `dist/assets` — a token a bundler drops or a
minifier rewrites is caught there, and neither gate needs a display or a WebView:

```sh
python3 ../tools/bench/color-contrast.py dist/assets
python3 ../tools/bench/responsive-check.py src/style.css src/style/tokens.css
```

A claim about what the *renderer* does — that a stored theme repaints a row, that a
refused font stack still measures the row it claims, that a refused fragment leaves the
list alone — is measured rather than assumed by a third probe. Unlike the two gates
above it this one needs a display, the WebKitGTK bindings and the interpreter that has
them (`/usr/bin/python3`); it refuses with a reason when any of the three is missing:

```sh
/usr/bin/python3 ../tools/bench/webkit-engine-probe.py appearance-engine-probe.ts src/style.css src/style/tokens.css
/usr/bin/python3 ../tools/bench/webkit-engine-probe.py search-layer-engine-probe.ts src/style.css src/style/tokens.css
```

A probe that builds a *view* rather than a document has to answer for the runtime the
view asks about at import time: `tools/bench/probe-tauri-stub.ts` installs the small
invoke surface a view module uses, and must be the probe's first import.

`app/src-tauri/examples/watch_probe.rs` is a manual `cargo run --example`.

## Architecture

### The backend owns all Git semantics; the frontend only renders

`app/src-tauri/src/` contains the backend modules. The Tauri command layer in `main.rs`
is mechanical boilerplate — `spawn_blocking` + `app.state::<T>()` + a `map_err` to
`task_failed` — repeated per command. Nothing semantic lives there.

The frontend (`app/src/`) has **no Git knowledge at all**. It cannot build a command, it
never sees a real filesystem path, and every action is a semantic `invoke` of a Rust
command. Views receive injected actions; `shell.ts` and `views/*` hold no Git rules.

### Three seams, each a single choke point

**1. `runner.rs` — the only place a Git process is spawned.**
`run_with_limit(command, &cancelled, close_stdin_after, timeout, output_limit, progress)`.
Behind that small interface live process-group isolation (grandchildren die with the
group), exit status delivered as an *event* on a channel rather than discovered by
sleeping, and output limits that truncate the capture while still streaming every byte to
`progress`. `truncated` is always surfaced — never parse a truncated capture.

**2. `session.rs` + `model.rs` — the snapshot/version protocol.**
`SessionState` holds the only mutable repository state. A refresh is
`capture` → `publish`, and `publish` takes a monotonic `version`. Everything else follows:

- Every write command carries `snapshot_version`; a mismatch is `write_stale_snapshot`.
- `FileId` is an opaque handle valid **only within the snapshot that produced it**.
  `PathTable` maps it back to the exact raw bytes; `display_name()` produces a string that
  cannot be converted back into a path.
- The frontend mirrors the version rule in `state.ts::applySnapshot` — an older snapshot
  never replaces a newer one.

`publish` also mints a `sessionId` — a new number on every session, including a second
repository whose head equals the first — and counts `historyGeneration` /
`refsGeneration` separately, each bumped only when its own domain's input moved.
A repository read is asked with a `ReadContext { sessionId, generation }` and answers
inside `SessionRead { context, value }`; `session::bind_read` refuses an answer whose
session has closed or whose generation has been superseded, and the panel drops one that
arrives anyway. The echo is what makes the check possible: without it a late reply is
indistinguishable from a current one. A listing no domain owns asks with
`ReadDomain::Session` (`generation: null`) — bound to the session, never invalidated by a
refresh — rather than inventing a counter nothing maintains.

Refresh requests coalesce through a leader/rerun gate, so a burst of watcher events runs
one Git capture, not one per event.

**3. `write.rs` — the single write lane and the one-time ticket.**
`WriteState::begin()` is a `compare_exchange` slot: a second submitter gets
`write_queue_busy` rather than queueing invisibly. `extools::ToolState` is a *separate*
lane on purpose — a diff window blocks for as long as the user keeps it open, and staging
must stay available meanwhile.

Every destructive operation (discard, clean, branch/tag delete, stash pop/drop, hard
reset, worktree removal) shares one flow:

```
preview_*  →  backend re-reads Git, computes the exact affected set
           →  stores it under a nonce, returns it
           →  frontend shows that list verbatim
confirm    →  take_preview() removes it FIRST (even if the recheck then refuses)
           →  the bound facts must still hold, or the operation is refused
```

What a ticket binds depends on the operation: a branch delete binds the observed `oid`;
the existing hard reset binds target + observed HEAD + the tracked-dirty file set.
That existing set is insufficient for the outline's clean-reset contract: the new
preview must also cover target-tree differences, obstructing and explicitly cleaned
untracked paths, and protected boundaries.
Nonces live in memory and die with the process. On the frontend, `preview.renew()` re-requests
the preview after **every accepted snapshot**, so a changed candidate set is re-shown and
must be confirmed again.

### Reading a rule that generalizes

A single idea recurs: **a read failure is never a clean repository.** A truncated status
is `git_status_truncated`, not "no changes". An unidentifiable `MERGE_HEAD` is
`OperationKindView::Unknown`, not "no conflict". Output bounds fail closed. When adding
any Git read, decide what the failure looks like before deciding what the success looks
like.

### No network, no credentials

guit stores no credentials and never needs one: every operation is local, and
clone, fetch, pull, push, force push, publishing, remote administration and the
askpass helper have no UI entry point, no command registration and no background
task. `repo::user_git_command` is where that is enforced. It strips every
inherited `GIT_*` variable, sets `GIT_TERMINAL_PROMPT=0` so that a repository
with an unreachable remote stays a readable repository instead of a hung prompt,
and turns off submodule recursion and lazy object fetching, so no read can pull
objects down behind the panel's back. Every other process guit starts goes
through it. The interactive helper's argv interception is gone with it; what
survives is the shared sweep of stale atomic-rename temporary files, because the
window geometry file writes through the same path.

A refusal caused by one of these controls is reported as a read or write failure,
never as a clean repository. `GIT_*` stripping must stay verified against the
supported Git versions before any further environment control is added.

## Rules that are enforced by tests — do not break them

These are architecture rules turned into gates. Passing them is not optional; changing
the code they scan is how you break them.

- **Never unwrap a poisoned lock.** `main.rs` has a test that reads every `.rs` in `src/`
  and fails on `.lock().unwrap()` or `wait_timeout(`. Use `util::guard` / `util::wait`.
  The reason: one panic must not turn every later request into "a lock was poisoned",
  naming neither the state nor the failure the user already saw.
- **Shipped text is a contract.** `app/tests/user-facing-copy.mjs` scans the READMEs,
  CHANGELOG, any Markdown this repository ships under `docs/` (a directory that is not
  there contributes no text), `app/src/`, `app/src-tauri/src/` and `capabilities/` —
  **comments included** — and fails on milestone labels (`M7`, `M6-11`), `plan/...`
  citations and `decision N` references. The historical development plan was deleted.
  The current `plan/` directory is internal engineering guidance; neither its paths nor
  task labels belong in shipped text. Name behaviour, not schedule. Keep the existing
  gate intact.
- **Every command answers to the thing it is bound to.** `app/tests/ipc-surface.mjs` reads
  the real signatures out of `main.rs` and `src-tauri/src/*.rs` and sorts the registered
  commands four ways: a repository read bound to a session and a generation (asked with a
  `ReadContext`, answering with a `SessionRead`), a write bound to a `snapshot_version`, a
  destructive confirmation bound to a one-time `nonce`, and an explicit exemption. The four
  lists must cover the registry without overlapping, and an exempt command may not quietly
  take on a per-repository read. Reclassifying one is a deliberate edit to that table, not
  an accident in a signature.
- **Row heights track the stylesheet.** `fileModel.ts` exports `FILE_ROW_REM` /
  `HISTORY_ROW_REM` that must equal `--row-height` / `--row-height-history` in
  `style/tokens.css`; a test gates it. The virtual lists derive row height from the root
  font size, so a hard-coded pixel constant silently breaks scroll position and selection
  under interface zoom.
- **Keep the pure models importable.** `fileModel.ts`, `historyModel.ts` and
  `railModel.ts` are imported directly by `node --test` with no build step. They must
  stay free of DOM access and of non-erasable TypeScript.
- **`npm run test:fixture` does not typecheck.** `tsc --noEmit` runs only in
  `npm run build`. Run both.

## Verification status

Recorded application runtime evidence comes from one Linux host (Ubuntu 26.04,
Git 2.53, WebKitGTK / GTK 3, Node 26). **Windows and macOS are build configuration only and have never been
run.** CI is configured in `.github/workflows/`; no CI pass has been verified in the
current records. An `origin` remote exists, but its presence does not prove a workflow
ran or passed. Do not claim a CI pass, and do not claim platform coverage this
paragraph does not record. What is *not* verified is written in the plan note of
the stage that left it open and indexed by that stage's row in
`plan/README.md`'s delivery table; `CHANGELOG.md` is the record of what changed.

`tools/bench/` and `tools/live/` hold the performance, accessibility and layout harnesses
(deterministic fixtures, AT-SPI probes, contrast and geometry checks, a live screenshot
rig). `GUIT_PERF=1` turns on phase timing to stderr; labels carry phase names only.

**Each harness asserts only what its channel can see.** AT-SPI has no z-order, so the
Python probes assert presence, reachability and focus — never absence, and never that a
layer covers something. Whether the branch picker hides the panel is a rendering fact:
`layout-probe.mjs` measures it with clip-aware painted rectangles for overlap and
overflow, and a node's own layout box for "showing, carries text, too small to draw".
That probe stubs the IPC layer, and a stub must answer the way the backend publishes —
a fresh copy with a higher `version` per session answer. Handing the app one mutable
object lets a mutation raise the stored snapshot's own version, `applySnapshot` drops
the refresh as not newer, and the probe then measures its own first screen while
reporting green.

The AT-SPI probes have three channels and an assertion must pick the one that can see
its subject: node *names* carry controls only (a plain label span has no accessible
name, so it can never be a landmark), `dump()` carries label text, and a node's extents
carry geometry. Extents are logical pixels; `window.json` stores physical ones (the
restore multiplies the 340x400 minimum by the monitor scale factor), so a seeded width of
800 measures 400. The document node also reports its scrollable content height rather
than the frame's, so a window-size claim is a width claim, made against the same window's
own box and never against a number. A floating layer — an open menu, a dialog — is drawn
over the page on purpose, so overlap is asserted only between two nodes in the same
layer; the layer is printed per state so a pass that compared one node cannot look like a
measurement.

Run these probes with `/usr/bin/python3`, which has `gi` and `Atspi`. The `python3` on
PATH may be a distribution-free interpreter without them; concluding from it that the
host cannot run the harnesses is how a whole suite got recorded as unverified while it
was runnable all along. Measure a committed state from a separate worktree when the
shared tree carries another developer's uncommitted code, or the result is about their
work and not about the claim being tested.
