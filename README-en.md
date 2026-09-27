# guit

A small, low-resource desktop Git client. It covers the everyday workflow —
working-copy status, staging, commits, branches, tags, stash, history, merge
and rebase conflicts, worktrees, submodules and remote sync — in one compact
window, with an optional always-on-top mode for keeping it beside a terminal.

guit runs **your** installed `git` with **your** own configuration. Hooks,
commit signing, credential helpers and ssh-agent behave exactly as they do in
a terminal, because there is no second Git implementation hiding underneath.

## What it deliberately does not do

**guit never shows file contents or diffs.** It is not an editor. Opening a
file, reading a diff and resolving a conflict all leave for the tools you
already configured — `git difftool`, `git mergetool`, and the system file
opener. guit stays out of the way of the tools where you actually read code.

Because of that, guit stays small: it holds a snapshot of your repository
state and the operations you can perform on it, not the contents of your
working tree.

## Requirements

- **Git 2.23 or newer** on `PATH`. (guit probes for `git restore` support at
  startup; it was built and verified against Git 2.53.)
- **Linux** with WebKitGTK 4.1 / GTK 3, which the package dependencies pull in.
- Windows and macOS packages are configured and buildable, but the app has
  **never been run on either platform** — see
  [docs/known-limitations.md](docs/known-limitations.md).

## Install (Linux)

```sh
sudo dpkg -i guit_0.0.1_amd64.deb     # Debian / Ubuntu
sudo rpm -i guit-0.0.1-1.x86_64.rpm   # Fedora / openSUSE
```

The AppImage also runs, but it needs `APPIMAGE_EXTRACT_AND_RUN=1` set both to
build it and to launch it, because `appimagetool` mounts its image through
FUSE:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./guit_0.0.1_amd64.AppImage
```

## Getting started

On first launch guit shows a welcome view with two ways in: **open a
repository** already on disk, or **clone** one by URL or local path. It
remembers what you opened and restores it next time.

The window is arranged like an editor's source-control sidebar: an app bar
across the top with the repository, the current branch and the global actions;
a rail down the left switching between seven views; and a status bar along the
bottom that carries the running operation, the filesystem-watch mode and the
interface zoom controls.

### The seven views

| View | What it is for |
| --- | --- |
| **Changes** | Your working copy, grouped into staged, unstaged and untracked files. Stage and unstage inline, open the `⋯` menu on any row for diff, open, discard or conflict resolution, write the message and commit (with an optional **Amend**). |
| **History** | Commits, newest first, with a draggable detail pane. **Load older** pages through history without rebuilding the whole list. |
| **Branches & Tags** | Search, create, switch, rename and delete branches; create annotated or lightweight tags; pick a tracking upstream. Destructive actions preview first. |
| **Stash** | Stash your current changes and list what's stashed. |
| **Remotes** | Add remotes, fetch, pull and push. Choose the pull strategy (merge, rebase, fast-forward only, or Git's own default) and publish a branch. |
| **Worktrees & Submodules** | Register and prune linked worktrees, and initialise or update submodules. |
| **Settings** | Theme, interface zoom, always-on-top, the full shortcut list, an environment check (**Check again**), and **Export diagnostics…**. |

Settings is the one view available even when no repository is open, so theme,
zoom and diagnostics stay reachable from a cold start. The other six are
disabled until you open a repository.

### Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `O` | Open a repository |
| `Ctrl`/`Cmd` + `R` | Refresh status |
| `Ctrl`/`Cmd` + `1`…`7` | Switch view |
| `Ctrl`/`Cmd` + `Enter` | Commit, from the message box |
| `Ctrl`/`Cmd` + `=` / `−` / `0` | Interface zoom in / out / reset |
| `Escape` | Close the open dialog or menu |

Interface zoom is 12–24px, and the theme follows your system by default with
a manual override. Both preferences persist across restarts.

## Destructive operations are never one click

Force pushes, hard resets, branch deletion and discarding changes all go
through the same path: guit computes exactly what would be affected, shows you
that list, and refuses the confirmation if the candidate set changed in the
meantime. A confirmation is single-use and dies with the process — quitting
guit mid-dialog cannot leave a pending destructive action behind for you to
walk into after a restart.

## Your credentials stay yours

**guit stores no credentials.** There is no guit-owned credential file, no
keychain entry, and no in-memory cache that outlives a single operation. It
uses your installed `git`, so your existing credential helper and ssh-agent do
the work. When an operation needs a password, guit can prompt for it through a
short-lived askpass bridge that is removed when the operation ends — including
after a crash. SSH passphrases are not prompted for at all; ssh-agent is the
only supported path. See [docs/credentials.md](docs/credentials.md).

## When something goes wrong

**Export diagnostics…** in Settings → Environment & diagnostics writes a
plain-text report. It first shows you a manifest of exactly what the file
contains — versions, your credential *posture* (never the credentials),
remote URLs with any embedded credentials redacted, and recent event
summaries. Passwords, tokens, prompt text, commit messages and file contents
are excluded by construction, and the home directory path is folded away.

## Files guit writes

Configuration lives in your platform config directory — on Linux,
`~/.config/dev.guit.desktop/`:

| File | Holds |
| --- | --- |
| `session.json` | The currently open repository |
| `recent.json` | The recent-repositories list |
| `window.json` | Window position, size, maximized and always-on-top |

These files migrate **forward only**. A guit that meets a `schema_version`
newer than it understands refuses to read the file and leaves the bytes
untouched, so installing an older guit can never rewrite newer state. Only a
newer guit ever writes a newer schema, and it backs the old file up when it
does.

## Documentation

- [docs/external-tools.md](docs/external-tools.md) — configuring diff, merge
  and file-opening tools, and what their exit codes mean to guit.
- [docs/credentials.md](docs/credentials.md) — exactly how guit handles
  authentication.
- [docs/known-limitations.md](docs/known-limitations.md) — what is verified,
  what is not, and the platform matrix. Read this before assuming a feature
  works on your platform.
- [CHANGELOG.md](CHANGELOG.md) — what changed in each release.

## License

MIT — see [LICENSE](LICENSE).
