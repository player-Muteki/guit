# Changelog

All notable changes to guit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. This file is the record of what changed; `docs/known-limitations.md`
is the record of what is not verified.

## [0.1.0] - 2026-09-25

First feature-complete release milestone (M0–M6). Verified on Linux
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
