# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

guit is a Tauri 2 + framework-free TypeScript desktop Git client. It drives the user's
own `git` binary with the user's own config; there is no second Git implementation and
no vendored library.

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
cargo test --manifest-path src-tauri/Cargo.toml --test askpass_e2e   # integration test
```

Two stylesheet gates, both pure-stdlib Python, both must run **after** `npm run build`
because they read the *built* bundle in `dist/assets` — a token a bundler drops or a
minifier rewrites is caught there, and neither gate needs a display or a WebView:

```sh
python3 ../tools/bench/color-contrast.py dist/assets
python3 ../tools/bench/responsive-check.py src/style.css src/style/tokens.css
```

`app/src-tauri/tests/askpass_e2e.rs` spawns the real binary and drives a loopback 401
server. It is `#![cfg(unix)]` and needs the bin target built, so plain `cargo test`
covers it. `app/src-tauri/examples/watch_probe.rs` is a manual `cargo run --example`.

## Architecture

### The backend owns all Git semantics; the frontend only renders

`app/src-tauri/src/` is 27 modules. The Tauri command layer in `main.rs` is mechanical
boilerplate — `spawn_blocking` + `app.state::<T>()` + a `map_err` to `task_failed` —
repeated per command. Nothing semantic lives there.

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

Refresh requests coalesce through a leader/rerun gate, so a burst of watcher events runs
one Git capture, not one per event.

**3. `write.rs` — the single write lane and the one-time ticket.**
`WriteState::begin()` is a `compare_exchange` slot: a second submitter gets
`write_queue_busy` rather than queueing invisibly. `extools::ToolState` is a *separate*
lane on purpose — a diff window blocks for as long as the user keeps it open, and staging
must stay available meanwhile.

Every destructive operation (discard, clean, branch/tag delete, stash pop/drop, hard
reset, worktree/remote removal, remote-branch delete, force push) shares one flow:

```
preview_*  →  backend re-reads Git, computes the exact affected set
           →  stores it under a nonce, returns it
           →  frontend shows that list verbatim
confirm    →  take_preview() removes it FIRST (even if the recheck then refuses)
           →  the bound facts must still hold, or the operation is refused
```

What a ticket binds depends on the operation: a branch delete binds the observed `oid`;
hard reset binds target + observed HEAD + the exact tracked-dirty file set; force push
binds `(remote, branch)` + the local oid + the `--force-with-lease` lease oid. Nonces
live in memory and die with the process. On the frontend, `preview.renew()` re-requests
the preview after **every accepted snapshot**, so a changed candidate set is re-shown and
must be confirmed again.

### Reading a rule that generalizes

A single idea recurs: **a read failure is never a clean repository.** A truncated status
is `git_status_truncated`, not "no changes". An unidentifiable `MERGE_HEAD` is
`OperationKindView::Unknown`, not "no conflict". Output bounds fail closed. When adding
any Git read, decide what the failure looks like before deciding what the success looks
like.

### Credentials

guit stores nothing. The default is `GIT_TERMINAL_PROMPT=0` with no `GIT_ASKPASS`; the
only path to a secret is the explicit "Retry with credentials", which attaches a
`askpass::Bridge` living exactly as long as that one operation. `main()` intercepts its
own argv before any Tauri machinery runs and acts as the helper. SSH passphrases are
refused by design — ssh-agent is the only sanctioned path. `repo::user_git_command`
strips every inherited `GIT_*` variable; interactive commands re-add exactly three.

## Rules that are enforced by tests — do not break them

These are architecture rules turned into gates. Passing them is not optional; changing
the code they scan is how you break them.

- **Never unwrap a poisoned lock.** `main.rs` has a test that reads every `.rs` in `src/`
  and fails on `.lock().unwrap()` or `wait_timeout(`. Use `util::guard` / `util::wait`.
  The reason: one panic must not turn every later request into "a lock was poisoned",
  naming neither the state nor the failure the user already saw.
- **Shipped text is a contract.** `app/tests/user-facing-copy.mjs` scans the READMEs,
  CHANGELOG, `docs/`, `app/src/`, `app/src-tauri/src/` and `capabilities/` — **comments
  included** — and fails on milestone labels (`M7`, `M6-11`), `plan/...` citations and
  `decision N` references. The development plan was deleted; a surviving label is now a
  citation to nothing. Name behaviour, not schedule.
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

All runtime evidence comes from one Linux host (Ubuntu 26.04, Git 2.53, WebKitGTK /
GTK 3, Node 26). **Windows and macOS are build configuration only and have never been
run.** CI is configured in `.github/workflows/` but has never executed — the project has
no git remote. Do not claim a CI pass, and do not claim platform coverage that
`docs/known-limitations.md` does not. That file is the record of what is *not* verified;
`CHANGELOG.md` is the record of what changed.

`tools/bench/` and `tools/live/` hold the performance, accessibility and layout harnesses
(deterministic fixtures, AT-SPI probes, contrast and geometry checks, a live screenshot
rig). `GUIT_PERF=1` turns on phase timing to stderr; labels carry phase names only.
