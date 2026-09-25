# guit

A lightweight, cross-platform desktop Git client. guit covers the everyday
Git workflow — status, staging, commits, branches, stash, history, merge
and rebase conflicts, worktrees, submodules and remote sync — in a small
window that stays out of your way, with an optional always-on-top mode.

guit deliberately shows **no file contents and no diffs**. It is not an
editor: files, diffs and conflict resolution open in *your* configured tools
(`git difftool` / `git mergetool` / the system opener). guit runs your
installed system `git` with your own configuration — hooks, signing,
credential helpers and ssh-agent all keep working exactly as in a terminal.

## Requirements

- **Git 2.23 or newer** on `PATH` (guit probes `git restore` support at
  startup; the development and verification cycle used Git 2.53).
- Linux desktop with WebKitGTK 4.1 / GTK 3 (pulled in by the package
  dependencies). Windows and macOS builds are configured but their runtime
  verification is still pending — see `plan/M6-validation.md`.

## Install (Linux)

```sh
sudo dpkg -i guit_0.1.0_amd64.deb     # Debian/Ubuntu
sudo rpm -i guit-0.1.0-1.x86_64.rpm   # Fedora/openSUSE
```

Or run the AppImage (`./guit_0.1.0_amd64.AppImage`) — it was produced and
launched during verification on Ubuntu 26.04, but distribution beyond that
host is untested (see `docs/known-limitations.md`).

## Build from source

Prerequisites: Rust (1.96+), Node 22+ (the 0.1.0 cycle built and verified
with Node 26), Tauri 2 system dependencies
(see <https://v2.tauri.app/start/prerequisites/>; Linux needs
`libwebkit2gtk-4.1-dev`).

```sh
cd app
npm install
npm run tauri build -- --bundles deb,rpm   # artifacts under app/src-tauri/target/release/bundle/
```

For development iteration: `npm run tauri dev`.

> **Note:** build the release binary through `npm run tauri build` (or
> `npm run tauri dev`), not plain `cargo build --release` — the Tauri CLI
> embeds the compiled frontend; a bare cargo binary would try to load the
> dev server instead.

## First run

Open a repository (or clone one) from the top of the Changes card; guit
remembers the last repository and restores it on next start. Right-hand
cards cover branches, remotes and syncing, stash, worktrees, submodules and
history. Dangerous operations (force push, hard reset, branch deletion…)
always show a preview of exactly what is affected and require explicit
confirmation before anything changes.

If something misbehaves, **Export diagnostics…** in the Environment check
card writes a plain-text report — but only after showing you a manifest of
exactly what it contains: versions, credential *posture*, redacted remote
URLs and recent event summaries. Passwords, tokens, tickets, prompts, commit
messages and file contents are excluded by construction.

guit's own config files (session, window, recent list) migrate **forward
only**: a guit that finds a newer `schema_version` than it understands
refuses to read the file and leaves the bytes untouched, so installing an
older guit can never rewrite newer state. When a future version introduces
a newer schema, that newer guit reads the old file, upgrades it once and
backs the old file up; older versions keep refusing and preserving.

## Documentation

- `docs/external-tools.md` — configuring diff/merge tools, exit-code semantics.
- `docs/credentials.md` — how guit handles authentication (spoiler: it stores nothing).
- `docs/known-limitations.md` — honest list of platform and feature gaps.
- `CHANGELOG.md` — release history.
- `plan/` — the full design and verification record behind this release.

## License

MIT — see [LICENSE](LICENSE).
