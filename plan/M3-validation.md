# M3 verification record

## Environment observed on 2026-09-24

Identical to M1/M2 (see `M1-validation.md`, `M2-validation.md`): Ubuntu 26.04 (resolute), Linux x86_64 kernel 7.0.0-31, GNOME Wayland (XWayland, HiDPI scale 2), rustc/Cargo 1.96.1, Node 26, Git 2.53.0, Tauri crate 2.11.6, WebKitGTK 2.52.6 / GTK 3.24.52. All runtime evidence below is from this single Linux host.

## Build and automated tests

- `cargo test --locked`: 133 tests pass — the 94 M0–M2 tests plus 39 M3 tests:
  - `history` (12): fixed-field NUL-delimited `%x1f`-guard fail-closed parse, topo-order `--skip` pagination cursor with `hasMore`, OID-only target resolution, subject/author/date fields, `--`-separator refusal for oid-like inputs, output-limit truncation (`history_truncated`), unborn `git log` structured refusal (`history_page_failed`), commit file listing + rename entries, metadata fields, valid-OID gate rejecting non-hex/payloads.
  - `refs` (5): `for-each-ref` 8-field fail-closed protocol, `%(HEAD)` current-branch marker (empty when detached), lightweight vs annotated peel (`*objectname` only for tag objects — annotation trusted only when `objecttype == "tag"` after measuring the `%(contents)` commit-message fallback), non-addressable/symbolic ref marking, display-name mapping.
  - `branches` (11): create/switch/rename/delete through the write queue; `check-ref-format` echo gate (user's Git validates the user's name; mismatch → Rejected), duplicate/shorthand/ghost-name refusals, stale-version chain, delete preview ticket (kind-tagged, single-use, oid re-compare), force-guard for unmerged deletes, plus the M3-06 edge cases: detached HEAD keeps refs/history/writes consistent (delete-other-branch, create, switch all legal while detached), unborn HEAD refuses create/switch/delete/history with Git's real 128 refusals and an external first commit unlocks every path without reopening the session, external-terminal rename+commit observed by the next write, refreshed history and ref listing (history follows the branch switched to; vanished switch target surfaces as Git-Failed with stderr kept).
  - `tags` (8): dual-layer name validation (cheap precheck + `check-ref-format refs/tags/<name>`), 12-name rejection matrix, lightweight/annotated round trip with peel assertions, create at HEAD or explicit oid, annotation via 0600 temp file (`TOPSECRET` non-leak asserted on serialized `OperationResult`), duplicate → Rejected, delete ticket chain (expiry/replay/drift/cross-kind refusal), unborn create refusal, pre-Git cancellation still refreshing.
  - `write`/`session` additions folded into their module counts (PreviewKind generalization to ref deletes, detached head-state mapping).
- `npm run test:fixture`: 9 node tests pass (unchanged; M3 added no frontend pure-model functions).
- `npm run build` (`tsc --noEmit` + vite) passes with no type errors; `cargo fmt --check` and `git diff --check` pass.
- `npm run tauri build -- --bundles deb,rpm` produces guit_0.1.0_amd64.deb (3,732,450 B) and guit-0.1.0-1.x86_64.rpm (3,733,125 B) with no compiler warnings (AppImage remains blocked by the M0 network issue for AppRun download).

## Runtime GUI verification (release binary, AT-SPI)

Driven through `/usr/bin/python3` + `gi.repository.Atspi` (`do_action(0)` on named buttons, `Atspi.Text.get_text` on status/paragraph nodes; every lookup re-walks the tree because WebKitGTK swaps accessibles across renders and stale `do_action` calls silently no-op) against the packaged release binary, on a disposable fixture `/tmp/guit-m3-runtime/repo` (seeded `session.json` for startup restore; 3 commits with the middle one tagged `lite` (lightweight) + `ann` (annotated, two-line message); branch `side` at the tagged commit; repo-local config `diff.tool=guitfake`, `difftool.guitfake.cmd='true'`). Final run: **ALL-PASS (15 checks)**:

- Session restore opened the fixture; References list rendered `* main` / `side` and `T ann annotated → <oid8>` / `lite lightweight → <oid8>` with per-row buttons (`Switch to …`, `Rename branch …`, `Delete branch …`, `View tag …`, `Delete tag …`); History list rendered 3 rows with decorations (`HEAD -> main`, `tag: lite · tag: ann · side`).
- History select: click `second commit · …` → commit detail exposes `Copy OID` / `Diff commit` / `Tag from commit…`.
- Copy OID: `wl-paste` returned the full 40-hex commit id; status bar `Commit id copied.`
- Diff commit: fake difftool spawned and exited → status `Diff tool closed.`; repository state re-read, list unchanged.
- Load older on a 3-commit repo: no-op page boundary, no error, list unchanged.
- Tag view: click `View tag ann` → detail panel shows the annotation body (`annotated line one` readable via AT-SPI text) — annotated-vs-lightweight distinction visible in both list marker and detail.
- Tag delete: click `Delete tag lite` → inline preview warning → Confirm `Delete tag` → status `Tag deleted.`, `lite` row gone, ref-reload status then reads `2 branch(es), 0 remote ref(s), 1 tag(s).`
- Branch switch: click `Switch to side` → `* side` marker moves (transient result message is rewritten by the ref reload faster than one AT-SPI tree walk — asserted via marker + reload status).
- External terminal commit (on side, via git CLI): appeared in the History list within watcher latency without interaction.
- Branch delete round trip: `Delete branch temp` → preview → Cancel `Keep branch` → temp survives; re-preview → Confirm `Delete branch` → `Branch deleted.`, row gone. (An earlier probe also caught the real guard firing: an unmerged branch refused by `git branch -d` surfaced the force option instead of silently deleting.)
- Detached HEAD observed externally (`git switch --detach`): session line renders `detached HEAD at <oid8>`, no branch carries the `*` marker; external `git switch main` re-attaches and `* main` returns.
- AT-SPI driver note: repeated-press-until-effect helpers are required (stale accessibles after re-renders); the app itself never entered a bad state during the suite.

## Verification limitations on this host (honest gaps)

- **Create paths that need typed text are not runtime-verified.** Keyboard injection remains impossible on this host (GNOME Wayland drops XTEST keys for unfocused XWayland windows; WebKitGTK exposes no EditableText — re-confirmed this milestone: `get_editable_text_iface()` returns None on the entry nodes). Branch create/rename input, tag name/annotation input and commit message typing are covered by Rust temporary-repository tests (branches/tags suites) and the buttons' enable/disable gating was observed, but no end-to-end typed creation was clicked through. A manual keyboard pass is a handoff gate.
- **Race-shaped rejections are unit-tested only**: stale-snapshot refusals, ticket expiry/replay/drift/cross-kind, `write_queue_busy`, candidate growth between preview and confirm — deterministic in Rust tests, not reproducible by hand at AT-SPI speed.
- Detached HEAD was observed as a *state* at runtime (external switch) but no write operation was *clicked* while detached; detached write legality is unit-verified only.
- Windows path branches (paths not representable as UTF-8, `check-ref-format` under Windows config) and macOS behaviors unverified; single-platform claim: all runtime evidence above is Linux. Windows/macOS stay at CI unit-test level, as in M1/M2.
- `git log` decoration rendering relies on the user's Git version (2.53 here); older Git decoration formats untested beyond the fail-closed field parser.

## Platform matrix

| Behavior | Linux host | Windows | macOS |
| --- | --- | --- | --- |
| Log protocol, pagination cursor, fail-closed parse | Verified (unit) | Pending | Pending |
| Commit detail, file list, Copy OID, commit difftool | Verified (unit + runtime clicks) | Pending | Pending |
| for-each-ref listing, HEAD marker, tag peel | Verified (unit + runtime render) | Pending | Pending |
| Branch create/switch/rename (typed name) | Unit (temp repo); runtime blocked by keyboard gap | Pending | Pending |
| Branch switch via click | Verified (runtime) | Pending | Pending |
| Branch delete preview→recheck→confirm (+ cancel, force guard) | Verified (unit + runtime round trip) | Pending | Pending |
| Tag create (lightweight/annotated, 0600 message file) | Unit (temp repo); runtime blocked by keyboard gap | Pending | Pending |
| Tag view detail, delete ticket flow | Verified (unit + runtime clicks) | Pending | Pending |
| Detached / unborn HEAD states | Verified (unit + detached runtime render; unborn unit-only) | Pending | Pending |
| External-terminal moves refresh refs/history | Verified (runtime watcher) | Pending | Pending |

## Remaining gates (post-M3 handoff)

1. Manual keyboard pass on a real desktop: type branch/tag names and annotations, exercise Create branch/rename/create-tag round trips and the M1 shortcut set.
2. Click-through write while detached (create/switch/delete from a detached HEAD) on a real desktop.
3. Unborn-HEAD repository first-open experience in the UI (unit-verified refusals + unlock path).
4. Windows/macOS runtime matrices (ref-name validation under Windows Git, FSEvents-triggered history refresh, `open`/`explorer.exe`).
5. Real configured difftool for commit diffs on each platform (fake tool only so far).
