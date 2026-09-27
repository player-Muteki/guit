# Changelog

All notable changes to guit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. This file is the record of what changed; `docs/known-limitations.md`
is the record of what is not verified.

## [Unreleased]

Everything that has landed since 0.1.0. None of it changes what guit can do to
your repository; it changes the shape of the window, what a failure tells you,
and how much of the app one failure can take with it.

### Changed

- The window is a title bar, an app bar (repository, branch chip with
  ahead/behind, sync, commit, pin), an activity rail, one view at a time and a
  status bar. Before, all ten areas were cards stacked on one long scrolling
  page, so staging a change meant scrolling past stash, remotes and worktrees.
- The six views that need a repository are grey with a reason when none is
  open; Settings is application-level and stays reachable.
- Rows act on click and stay legible at a narrow width: at 480 px and below
  the duplicated wordmark and commit button go, the branch chip keeps a
  readable floor, names keep their space and details ellipsize instead, and
  worktree paths wrap onto deliberate lines rather than losing their tail.
- Settings scrolls as a document, so its sections keep their natural height.
  List views still scroll inside their own lists.
- A progress line updates the status bar instead of redrawing the whole window,
  and changing the interface zoom updates its own readout.

### Fixed

- Failures keep each other. They enter a stack of up to four notices, each with
  its own close button, so a second failure no longer replaces the first and a
  watcher refresh can no longer hide one.
- Cancelling a confirmation returns the keyboard to a control that still
  exists. The action that opened it is often rebuilt by the preview the dialog
  is waiting on, and focus was being left on the button that had just gone.
- The rail's hover hints tell the truth after a repository is open; each one
  used to keep saying that a repository had to be opened first.
- Commit and file lists measure their rows in the same units the stylesheet
  uses, so a zoomed interface no longer draws the wrong number of rows, and a
  group heading occupies exactly the row it is painted in.
- Loading an older page of history no longer skips a commit at the seam
  between pages.
- Commit rows announce themselves to a screen reader as the selectable items
  they are; group headings no longer claim to be selectable.
- A credential prompt that replaces the one already on screen says so, instead
  of discarding what you had typed without a word.
- A repository of roughly a thousand files or more reported its submodule list
  as "output too large" — including repositories with no submodules at all.
  The index listing now has a bound of its own instead of sharing the small
  limit meant for one-shot tool output.
- guit keeps serving later requests after any internal failure. Every shared
  lock was unwrapped, so one panicked command made each later one fail with "a
  lock was poisoned", which named neither the data nor the failure you had
  already seen.
- A `git` that starts and then never answers is reported as unresponsive. It
  used to hold the settings view, and the external-tool rows behind it, open
  forever.
- A clone that stops reporting is stopped. Two minutes of silence from Git ends
  the attempt and says it was guit that stopped it; before, the only bound on a
  clone was the one you pressed, so a remote that went quiet mid-transfer held
  the window open indefinitely.
- The commands guit probes at startup no longer describe themselves with an
  internal schedule label.

### Removed

- Two command endpoints that nothing called: one that read the stored window
  geometry (the backend already reads it directly while restoring the window)
  and one that reported credential posture (the diagnostics export reads it
  directly). Both were reachable from the webview and neither was ever used.
- A graph-layout helper that only its own tests called. Lane assignment now
  goes through the one function that does the work.

### Fixed

- Staging and unstaging can no longer be given an operation they do not
  implement. The write lane picked its Git arguments from a table covering
  every operation, and returned an empty argument list for all but the two
  that use it — so any operation routed that way would have run `git` with no
  subcommand. The two operations the lane serves are now its own type, and
  adding a third is a compile error rather than a silent mistake.
- The private directory a killed instance left for its credential bridge is now
  reliably removed at the next startup. Deciding whether a bridge socket still
  had a listener behind it by a single connect lost a race: on Linux a connect
  issued while the listener is being torn down can be queued and report
  success, so a dead bridge occasionally read as a running one and its
  directory stayed on disk. The probe asks a second time, which separates a
  queued request from a live listener without waiting on the far end. A live
  bridge was never at risk from the old check — it never reported failure — and
  four hundred runs under twelve-way load removed every dead bridge and no
  running one.

### Testing

- Every command the backend registers is checked against the frontend source,
  in both directions: an endpoint no view calls and a view calling an endpoint
  that does not exist both fail the suite. Joining the two halves of the app
  is done with a string, so neither the compiler nor any existing test
  covered a rename on either side.
- The confirmation paths for the two most destructive operations — a hard
  reset and a force push — are covered for cancellation, for a repository
  switch, for a partial overwrite list, and for a reported Git failure. Each
  new test was checked by removing the code it covers and confirming it fails.
- The five-second polling fallback, promised when a repository exhausts its
  filesystem watch limit, is now decided by a function that can be tested
  without an application window, and the mode shown in the window is checked
  against the mode the diagnostics report reads.
- The flake-tallying harness no longer reports success for rounds it never
  ran. It passed its own command through `xargs -I`, which strips the inner
  quotes, so the redirection and the bookkeeping were lost and every round
  looked like it had passed.

## [0.1.0] - 2026-09-25

First feature-complete release. Verified on Linux
(Ubuntu 26.04, Git 2.53); Windows and macOS runtime verification is pending
(see `docs/known-limitations.md`).

### Added

- Repository session: open a repository (or clone one), persistent recent
  list, automatic restore at startup, live watcher with monitor line and
  coalesced refresh.
- Changes view: full working-tree + index status (staged/unstaged rename,
  copy, conflict, untracked, ignored states), per-file stage / unstage /
  discard, commit box with signing respected via your Git hooks and GPG
  setup.
- In-flight operations: merge / rebase / cherry-pick / revert detection with
  continue and abort, `git mergetool` conflict resolution judged by re-reading
  the index.
- Branches and tags: list, create, switch, delete, merge, rebase onto,
  upstream binding; worktree list/add/remove/prune; submodule listing with
  streamed cancellable init/update.
- History: paged commit log with per-commit external difftool against first
  parent (empty-tree baseline for roots), reset with tiered risk where hard
  reset requires a rechecked one-time ticket.
- Remotes and sync: add/rename/remove remote, per-remote and sweep fetch,
  pull with strategy (Git default / ff-only / merge / rebase), push,
  publish branch, delete remote branch, force push only via
  preview → recheck → confirm ticket; non-fast-forward refusal classification;
  redacted URL display.
- Controlled interactive HTTPS auth: one-time "Retry with credentials"
  routes Git's real username/password prompts into an in-window dialog over
  a unix-only askpass bridge; secrets are never stored, logged or echoed.
  SSH passphrase prompting is refused by design — ssh-agent only.
- Stash push/pop/apply/drop; safe delete of local branches (merged-only
  rule); `clean` behind the same ticket discipline.
- Window: responsive resize from 320 px up, optional always-on-top,
  configuration persisted per monitor-clamped geometry.
- Performance baseline harness (`tools/bench/`, not packaged) and GUIT_PERF
  phase timing for diagnostics.
- Diagnostics export behind an explicit content-list confirmation: app/OS/
  Git versions, redacted remotes and paths, credential posture summary,
  recent redacted operation records — never tickets, secrets, prompts or
  file contents.

### Changed

- Installer metadata: publisher, license (MIT) and package descriptions.

### Known gaps at this version

- AppImage is produced and was launched on the verification host
  (Ubuntu 26.04); distribution beyond that host is untested. deb/rpm are
  the primary Linux artifacts.
- Windows/macOS: configured, not runtime-verified.
- Real-provider (GitHub/GitLab/Gitea) credential flows await a manual
  user-attended pass.
