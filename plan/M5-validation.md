# M5 verification record

## Environment observed on 2026-09-25

Identical to M1–M4 (see `M1-validation.md` … `M4-validation.md`): Ubuntu 26.04 (resolute), Linux x86_64 kernel 7.0.0-34, GNOME Wayland (XWayland, HiDPI scale 2), rustc/Cargo 1.96.1, Node 26, Git 2.53.0, Tauri crate 2.11.6, WebKitGTK 2.52.6 / GTK 3.24.52. All runtime evidence below is from this single Linux host.

## Build and automated tests

- `cargo test --locked`: 272 unit tests pass plus 5 integration tests in `tests/askpass_e2e.rs` — everything from M0–M4 plus the M5 suites (remotes M5-01, fetch/upstream M5-02, pull strategies M5-03, push/publish/delete/force M5-04, classification M5-05, askpass bridge M5-06, and the M5-07 matrix below; module totals are the current ground truth).
- M5-07 matrix (`network.rs` tests, five `m5_matrix_*` cases against local bare repositories end to end):
  - `m5_matrix_a_full_round_trip_keeps_head_tracking_and_bare_in_agreement`: peer advance → fetch reports `(0,1)` → ff-only pull → push a local commit → HEAD, `refs/remotes/origin/main` and the bare all agree and both repos `git fsck` clean.
  - `m5_matrix_divergence_refuses_a_plain_push_then_rebase_lands_linear`: diverged push fails with the `NonFastForward` category, bare and HEAD provably held → pull with Rebase → `main^ == bare_tip` and no second parent (linear) → push succeeds → agreement + fsck.
  - `m5_matrix_cancellation_reports_a_repository_exactly_as_it_was`: a pre-cancelled fetch reports `Cancelled` with `exit_code: None` and honest `(0,0)` movement (behind is unknowable before a fetch — a cancelled fetch must never fabricate it); HEAD, tracking ref, bare tip unchanged and fsck clean.
  - `m5_matrix_a_pull_conflict_resolves_continues_and_pushes_as_one_chain`: pull → `Conflicted` + operation banner → external resolve + `git add` → `operation_continue` → Success, banner gone, merge commit real (`HEAD^2`), resolved content from `git show` → push → bare carries the resolution.
  - `m5_matrix_a_published_branch_survives_a_remote_delete_and_republish`: publish binds upstream; `push --delete` removes the remote ref but **the `branch.topic.remote/merge` config survives** (measured; `%(upstream)` still prints with `[gone]`) → a second publish honestly refuses with `Outcome::Rejected` ("already tracks origin/topic", `exit_code: None`, bare untouched — refusals are results, not command errors) → a plain push recreates the branch and the session status reports explicit `Some(0)/Some(0)`.
- `npm run test:fixture`: 9 node tests pass.
- `npm run build` (`tsc --noEmit` + vite) passes; `cargo fmt --check` and `git diff --check` pass.
- `cargo clippy --locked --all-targets`: the pre-existing 12-warning baseline is unchanged; M5 code adds no new warnings.
- `npm run tauri build -- --bundles deb,rpm` produces guit_0.1.0_amd64.deb (4,177,204 B) and guit-0.1.0-1.x86_64.rpm (4,177,871 B) with zero compiler warnings (AppImage remains blocked by the M0 network issue for the AppRun download).

## Runtime GUI verification (release binary, AT-SPI)

Driven through `/usr/bin/python3` + `gi.repository.Atspi` against the packaged release binary on a disposable fixture `/tmp/guit-m5-runtime` (bare `origin.git` + clone `repo` with `main` pushed and upstream bound; `peer` clone to advance the bare from "elsewhere"; a second remote `sec` pointing at a loopback HTTP server that always answers `401 + WWW-Authenticate: Basic`). Final run: **ALL-PASS (36 checks)**:

- Session restore from the seeded `session.json`; Remotes card lists `origin` and `sec` (redacted URLs as row text); branch row reads `main → origin/main`.
- Fetch (per-remote Fetch button): peer commit makes the badge go `↓1`, bare advanced (plumbing cross-check) — progress and result ride the streamed `sync-progress` lane without wedging the UI.
- Pull (Git default): fast-forwards HEAD to the peer commit, badge clears.
- Push: external local commit shows `↑1`, Push lands it on the bare, badge clears.
- Publish: external `git branch topic` + "Switch to topic" + Publish → bare gains `refs/heads/topic`, row shows `→ origin/topic` (clicks racing two watcher refreshes are honestly refused as stale snapshots — the driver retried, see notes).
- Delete remote branch through the ticket: preview row `origin/topic · at <oid>` → Confirm "Delete remote branch" → gone on the bare, local branch survives, and the measured config survival is asserted as an end state (`branch.topic.remote` still `origin`).
- Non-fast-forward story: divergence badges (`↑1 ↓1`), Push refused with `[rejected]` captured on the status line, the hidden "Preview force push…" entry appears exactly because Git rejected, preview lists `Overwrites main on "origin"` plus the remote-only commit `distant-only d1`, "Keep remote history" dismissal leaves the bare provably untouched (nothing was ever force-pushed).
- Credential lane end to end at runtime: fetch of `sec` fails as auth and the one-time "Retry with credentials" button appears; the retry re-runs with the askpass bridge and **Git's real `Username for 'http://127.0.0.1:8099': ` prompt lands in the in-window dialog** (group name asserted from the AT tree, Submit/Cancel present); Cancel closes the dialog without ever typing a secret; after the measured 120 s bridge timeout the operation settles as an honest auth failure and the retry is re-offered; no garbage `refs/remotes/sec/*` anywhere.
- Final integrity: `git fsck` clean on both repos, story end state asserted through plumbing.
- AT-SPI driver notes (measured, not app defects): this pygobject's `Accessible.get_text(start, end)` raises TypeError (deprecated single-argument form) — the working call is the static `Atspi.Text.get_text(node, 0, -1)`, and `role.value_name` is a property; the WebKit tree populates lazily after startup so per-node reads must not retry-sleep (five sleeps per node starve every poll); off-viewport nodes report SHOWING=false, so visibility is decided by presence in the AT tree only (`hidden` ⇒ display:none ⇒ absent); row text arrives as the LIST_ITEM accessible name; the shared remote-status line is overwritten by snapshot-triggered reloads (M4 lesson, hit again on the `[rejected]` capture — effects carried the verdict); three DOM buttons share the accessible name "Cancel" (clone, commit, askpass) and the commit one is enabled during any write, so an unscoped cancel click fired `cancel_write` — dialog-scoped clicking was required; and a stale-snapshot refusal from a watcher double-refresh is correct app behavior the driver must retry through.

## Verification limitations on this host (honest gaps)

- **Typing into the askpass dialog is not runtime-verified** (unchanged keyboard-injection gap: GNOME Wayland drops XTEST keys for unfocused XWayland windows; WebKitGTK exposes no EditableText). The full submit path — helper spawn, socket, token, secret to Git, `Authorization: Basic` on the wire — is verified by `tests/askpass_e2e.rs` against a real `git ls-remote`, and at runtime only the render + cancel + honest-timeout legs were clicked.
- **Real-remote manual verification is the remaining gate** (task wording "用真实远端人工验证认证流程"): GitHub/GitLab/Gitea auth (HTTPS credential entry through the dialog, SSH agent, protected-branch refusals) needs a user-attended pass on a real account; everything above used local bares and the loopback 401 server.
- Pull strategy Select was not clicked through (no AT-SPI option-selection driver): the runtime pull used "Git default" on a fast-forwardable branch; FfOnly/Merge/Rebase arms and the default-rule tooltip are unit-verified only.
- Set URL / Remove remote / Add remote row buttons: the listing and preview-ticket lanes were runtime-clicked in earlier milestone passes; the M5 smoke covered Fetch/Pull/Push/Publish/Delete/Force-preview/Retry. `add_remote` typing remains unit-verified (keyboard gap).
- The 120 s unanswered-prompt settle was asserted once by design (timed wait), not varied; per-prompt timeout is fixed in Rust and unit-tested (`stopping_the_bridge_fails_a_waiting_helper_at_once` covers the immediate-teardown side).
- Windows/macOS unverified: the askpass bridge is unix-only by design (`Bridge::start` refuses off-unix with `askpass_unsupported`, recorded in `04-git-engine.md`), Windows named pipes/credential manager are a documented gap; SSH passphrase prompting is intentionally refused (ssh-agent guidance only).

## Platform matrix

| Behavior | Linux host | Windows | macOS |
| --- | --- | --- | --- |
| Fetch/pull/push against a local bare (badges, plumbing agreement) | Verified (unit matrix + runtime clicks) | Pending | Pending |
| Publish new branch + upstream binding; plain push recreating after remote delete | Verified (unit + runtime) | Pending | Pending |
| Delete remote branch ticket (preview → recheck → confirm) | Verified (unit + runtime; config-survival measured both) | Pending | Pending |
| Non-FF refusal, `[rejected]` classification, force-push preview lists overwritten commits, lease never fires unconfirmed | Verified (unit + runtime; forced push itself never executed at runtime by design) | Pending | Pending |
| Cancelled fetch reports honest `(0,0)` and unchanged repos | Verified (unit) | Pending | Pending |
| Pull conflict → banner → continue → push chain | Verified (unit matrix; merge-conflict banner clicked in M4 runtime) | Pending | Pending |
| Credential retry offer on auth failure + askpass dialog render/cancel/timeout | Verified (runtime click-through) | Not supported by design (unix bridge) | Pending |
| Secret actually reaching Git through the dialog (submit leg) | Verified (integration test with real `git ls-remote` + 401 server) | Pending | Pending |
| SSH agent presence reporting; passphrase refusal | Verified (unit; refusal by design) | Pending | Pending |
| Redacted URL display in the remotes list | Verified (unit; row text observed at runtime) | Pending | Pending |

## Remaining gates (post-M5 handoff)

1. Manual real-remote pass on the user's own account: HTTPS credential entry through the askpass dialog, an SSH-agent-backed fetch/push, and a protected-branch push refusal.
2. Keyboard-driven flows (remote add/Set URL typing, pull-strategy selection) whenever typed input becomes automatable; until then unit-verified only.
3. Windows/macOS matrices, starting with the askpass gap policy: whether to ship an equivalent bridge or keep the refusal with guidance.
