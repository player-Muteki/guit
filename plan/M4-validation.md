# M4 verification record

## Environment observed on 2026-09-24

Identical to M1–M3 (see `M1-validation.md`, `M2-validation.md`, `M3-validation.md`): Ubuntu 26.04 (resolute), Linux x86_64 kernel 7.0.0-31, GNOME Wayland (XWayland, HiDPI scale 2), rustc/Cargo 1.96.1, Node 26, Git 2.53.0, Tauri crate 2.11.6, WebKitGTK 2.52.6 / GTK 3.24.52. All runtime evidence below is from this single Linux host.

## Build and automated tests

- `cargo test --locked`: 193 tests pass — everything from M0–M3 plus the M4 suites below (module totals are the current ground truth):
  - `inflight` (8): the in-progress detection matrix — `MERGE_HEAD`/`CHERRY_PICK_HEAD`/`REVERT_HEAD` require a full valid OID on line one (corrupt → `kind=unknown`, never a fake-clean), `rebase-merge/` (head-name + msgnum/end) and `rebase-apply/` (next/last) recognize rebases, multiple simultaneous markers → `unknown`, marker-less conflicts (external `merge --no-edit` leaving `u` entries) surface as `unknown` with truthful text, unreadable marker files raise structured `inflight_read_failed` instead of guessing.
  - `stash` (10): integer-only client positions (`stash@{N}` selectors exist only server-side — `selector_cannot_be_typed_by_the_client`), `%gd%x1f%cI%x1f%s` fail-closed parse with selector/position cross-check, clean-tree refusal (`stash_nothing` — measured: `git stash push` on a clean tree exits 0 with "No local changes to save"), conflict-present refusal, unborn refusal, untracked files stay put (round trip asserts `keep.txt` survives), multi-line/UTF-8 message round trip, pop/drop one-time tickets (oid captured at preview, drift on confirm refuses, replay/cross-kind consumed tickets refuse), pre-Git cancellation still refreshing, bare repos read-only.
  - `sequencer` (13): divergent clean merge → two-parent commit; conflict → `Outcome::Conflicted` + banner state `merge("Merge branch 'side'")` + abort restores; externally resolved (`git add`) then continue produces the commit with Git's default message (measured editor deviation: merge/rebase stop-points take `GIT_EDITOR=:` only on the two `--continue` paths, documented in `04-git-engine.md`); rebase conflict step counts (`1 of 1`), skip completes, abort restores the original commit via reflog; in-progress refusal to start a second operation; target matrix (full OID or unique `refs/heads` name only — `HEAD~1`, `@{u}`, remotes, blanks rejected with `exit_code: None`, i.e. Git never spawned); stale snapshot refused at idle; cherry-pick keeps the original message and doesn't touch the source branch, conflicting pick → Conflicted → abort restores, externally-resolved pick continues without any editor handling (measured), `revert --no-edit` yields the `Revert "…"` inverse commit; pick/revert targets must resolve through `rev-parse --verify <oid>^{commit}` before Git starts.
  - `reset` (7): soft moves only HEAD (index and files byte-identical, asserted via `git show :path`), mixed restores the index (staged new file falls back to untracked, file still on disk), hard runs the preview-ticket chain (target oid + HEAD + exact dirty tracked-file set frozen at preview; any drift — worktree edited externally, branch moved, target gc'd, repo switched, operation in progress — refuses before Git with `exit_code: None`), measured destructive nuance: staged-then-never-committed new files ARE removed by `--hard` and must appear in the preview list (test asserts it), pure untracked files survive; `ModeArg` deserialization makes "hard" unreachable through the plain `reset` command entirely (type-level gate); >20 dropped commits truncate with an honest total.
  - `worktrees` (10): `worktree list --porcelain` fail-closed parse (paths with spaces via non-UTF-8 OsStr round trip, `detached`, `bare`, `locked`, `prunable`), add via dialog-returned absolute path + validated ref, the linked worktree's `.git` file points back at the main repo's `modules`-style gitdir and that gitdir carries per-worktree state, remove ticket (HEAD oid re-compare; dirty worktree refused by Git itself with the stderr kept, clean removal deletes the directory), double-checkout of one branch refused with Git's own message, prune clears vanished directories only (`Pruned 1 stale worktree record(s).` / `No stale worktree records.`), plus the cross-module scenario: **a merge in progress inside a linked worktree is detected from that worktree's private gitdir** (`session::capture` on the worktree → Conflicted banner `merge`, `MERGE_HEAD` present in the linked gitdir and absent from the common dir, main checkout's snapshot stays `operation: None`, abort through the worktree session restores it).
  - `submodules` (8): index-authoritative gitlink listing (`ls-files --stage -z` mode 160000, fail-closed record parse), `.gitmodules` mapping via `config -f --null --get-regexp`, per-path `git submodule status -- ':(literal)<path>'` verification (measured: bulk `git submodule status` dies 128 "no submodule mapping found" if ANY gitlink is unmapped, so per-path isolation is the protocol; unmapped gitlinks render as their own honest state instead of failing the list), uninitialized/`+`drift/up-to-date tri-state round trips (deinit → not initialized → `update --init` restores transport-free → bump → drift → update back), `:(literal)` pathspecs survive spaces and target exactly one entry, progress lines stream through the redaction-safe byte reassembly, pre-Git cancellation refreshes and reports honestly, no-submodule repos list empty (not an error).
  - `extools` (10 → 14, the +4 are M4-05): the mergetool lane — measured: Git 2.53 `mergetool` has **no** `--trust-exit-code` (probe-confirmed; the option belongs to difftool) and the tool's own exit code is not authoritative, so the outcome is decided entirely by re-reading the index: fake tool copying `$LOCAL` into `$MERGED` → conflict rows vanish (single-slot tool lane, mandatory refresh), fake tool exiting 0 **without** writing `$MERGED` → truthful "tool exited, conflict remains", the `sed -i` leaving conflict markers case is pinned to Git's real behavior (marker text still gets `git add`ed — index is the arbiter, not tool output), and a no-conflict path is refused before the tool spawns.
- `npm run test:fixture`: 9 node tests pass (workspace unchanged from M3).
- `npm run build` (`tsc --noEmit` + vite) passes with no type errors; `cargo fmt --check` and `git diff --check` pass.
- `npm run tauri build -- --bundles deb,rpm` produces guit_0.1.0_amd64.deb (3,954,868 B) and guit-0.1.0-1.x86_64.rpm (3,955,971 B) with no compiler warnings (AppImage remains blocked by the M0 network issue for AppRun download).

## Runtime GUI verification (release binary, AT-SPI)

Driven through `/usr/bin/python3` + `gi.repository.Atspi` against the packaged release binary on a disposable fixture `/tmp/guit-m4-runtime` (seeded `session.json`; base → `track b` → `main edit` with divergent `side` carrying a conflicting `side edit`; repo-local `merge.tool guitfake` + `mergetool.guitfake.cmd='cp "$LOCAL" "$MERGED"'`; an uninitialized submodule `sub`; linked worktree `wt` on `wtb`; dirty `a.txt` for the stash round trip). Final run: **ALL-PASS (32 checks)**:

- Startup render: Worktrees card shows 2 entries (`#0 …/repo main`, `#1 …/wt wtb`), Submodules card shows 1 entry as `not initialized`, Stash card reads `No stash entries.`, Changes lists the dirty `a.txt` row.
- Stash: click `Stash changes` → `#0 WIP on main: <oid> add submodule` row appears and the dirty row vanishes → click `Apply stash 0` → `a.txt` back in Changes **and** the stash entry survives (apply semantics, not pop).
- External terminal `git restore a.txt` cleared the Changes row through the watcher within seconds, no interaction.
- Merge conflict scenario end to end: click `Merge side into the current branch` → in-progress banner `Merge branch 'side'` appears with the conflict row offering `Resolve a.txt` → clicking Resolve spawned the configured fake mergetool, conflict row cleared while the banner stayed → `git diff --diff-filter=U` empty and `a.txt` holds our side's content → click `Continue` → banner clears and HEAD is a merge commit (`HEAD^2` verifies).
- Revert: select `track b · …` in History → detail offers `Revert` → one revert commit appears, `b.txt` gone from disk, driver-side assertion counts exactly one `Revert*` commit (the non-idempotent action needed a press-once-then-poll pattern; see driver notes).
- Reset soft: click `Reset soft` on `track b` → HEAD moves to that commit, no file touched (`b.txt` stays deleted), `git status --porcelain` now shows the staged deletion against the moved HEAD — the soft-mode contract asserted through effects, not just UI text.
- Submodule: click `Initialize and update submodule 0` → `sub/f.txt` on disk, list reloads to `1 submodule entry.` with the row state `up to date`.
- Worktree removal: `Remove worktree 1 after confirmation` → preview panel with the "Removing unregisters…" warning → Confirm `Remove worktree` → `wt/` deleted, `Worktree removed.` status.
- Final integrity: `a.txt` intact with merged content, stash entry still listed, no stray writes.
- AT-SPI driver notes (measured, not app defects): a whole file/stash row is one text node (`"M\na.txt\n…"`) so row presence asserts the exact aria-label buttons; transient accessibility-bus GErrors can surface mid-refresh (`app()` must wrap/retry — the first suite "crash" turned out to be a driver-side uncaught call while the app completed the revert correctly); result messages written to shared status lines (`Reverted …`, `Submodule initialized and updated.`) are rewritten by the snapshot-triggered list reload faster than one tree walk — same overwriting noted in M3 — so end-state assertions ride on effects (filesystem, git plumbing) plus the post-reload list text.

## Verification limitations on this host (honest gaps)

- **Typed inputs are not runtime-verified** (unchanged keyboard-injection gap: GNOME Wayland drops XTEST keys for unfocused XWayland windows; WebKitGTK exposes no EditableText). Stash message, worktree add target, commit messages and branch/tag names stay unit-verified only; the click-only stash round trip above used Git's default WIP subject.
- **Race-shaped rejections are unit-tested only**: ticket drift/replay/expiry, `write_queue_busy`, stale-snapshot refusals, dirty-set re-check on hard reset — deterministic in Rust, not reproducible by hand at AT-SPI speed.
- Pop/drop of stash entries, mixed/hard reset, cherry-pick and rebase buttons were **not click-driven** at runtime (revert/soft-reset/merge paths were); they share the same ticket/banner lanes as the verified flows but stay unit-verified only.
- The fake mergetool was the resolution path; a real configured tool (meld/vimdiff/…) has not been clicked through, and the "tool exits without resolving" branch is unit-tested only.
- `git worktree add` through the OS folder dialog needs keyboard/pointer dialog automation and was unit-tested with a direct path instead; removal, list and prune were runtime-verified.
- Submodule `protocol.file.allow`: measured that Git 2.53 **ignores the setting in local repo config** (security), so local-path submodule fixtures need `-c protocol.file.allow=always` on the test command line; guit injects no `-c` overrides (user-config respect), meaning file-transport submodule adds keep failing with Git's own honest error until the user configures their Git — by design, documented in `submodules.rs`.
- Windows/macOS unverified: `stash@{N}` argv quoting on Windows, `GIT_EDITOR=:` semantics on Windows (recorded as a platform gap in `04-git-engine.md`), NTFS path/worktree layouts, FSEvents-driven watcher refresh, macOS `open`-based mergetool lanes — everything above is single-platform Linux evidence.

## Platform matrix

| Behavior | Linux host | Windows | macOS |
| --- | --- | --- | --- |
| Stash list/save/apply (click path, WIP subject) | Verified (unit + runtime clicks) | Pending | Pending |
| Stash message typing, pop/drop tickets | Unit (temp repo) | Pending | Pending |
| Merge/rebase start, Conflicted outcome, continue/abort/skip | Verified (unit + merge runtime round trip incl. mergetool + continue) | Pending | Pending |
| Cherry-pick / revert conflict lanes | Unit (temp repo); revert verified at runtime, pick unit-only | Pending | Pending |
| In-flight banner rendered from snapshot markers | Verified (runtime for merge; matrix unit) | Pending | Pending |
| Reset soft (HEAD-only move) | Verified (unit + runtime effects) | Pending | Pending |
| Reset mixed / hard ticket chain | Unit (temp repo; incl. staged-new-file deletion measurement) | Pending | Pending |
| External mergetool resolve + honest "still conflicted" re-check | Unit (fake tool, both branches); "resolved" branch runtime-clicked | Pending | Pending |
| Worktree list / remove-confirm / prune | Verified (unit + runtime) | Pending | Pending |
| Worktree add via folder dialog | Unit (direct path) | Pending | Pending |
| Linked worktree carries its own in-flight state | Verified (cross-module unit) | Pending | Pending |
| Submodule index-authoritative status + init/update | Verified (unit + runtime, local-path fixture) | Pending | Pending |
| Long-task progress streaming + cancel (submodule) | Unit (byte reassembly, pre-Git cancel) | Pending | Pending |
| `protocol.file.allow` file-transport refusal surfaced honestly | Verified (measured behavior, unit documents it) | Pending | Pending |

## Remaining gates (post-M4 handoff)

1. Manual keyboard pass: type a stash message, a worktree add path/target, run pop/drop and hard-reset confirmations end to end on a real desktop.
2. Real configured mergetool (not the fake) for a conflict resolution, on each platform.
3. Cherry-pick multi-commit chains and interactive rebase at runtime (out of guit scope by design for the sequencer editor, but the rebase start/skip/abort lanes deserve a click pass).
4. Windows/macOS runtime matrices, especially `GIT_EDITOR=:` equivalence on Windows and `stash@{N}` quoting.
5. Network-transport submodule flows (SSH/HTTPS agents) with real credentials — untouched by M4's local-path fixtures.
