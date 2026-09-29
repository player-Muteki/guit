# guit

A small, low-resource desktop Git client for the work in front of you. It
covers the everyday local workflow — working-copy status, staging, commits,
branches, tags, history, merge and rebase conflicts — in one compact window,
with an optional always-on-top mode for keeping it beside a terminal.

guit runs **your** installed `git` with **your** own configuration. Hooks,
commit signing, credential helpers and ssh-agent behave exactly as they do in
a terminal, because there is no second Git implementation hiding underneath.

## What it deliberately does not do

**guit is local-only.** It never touches the network: no cloning, fetching,
pulling, pushing, force pushing, publishing or remote administration, and no
credential prompt of any kind. Your remotes and your credential setup stay
exactly as Git has them, and the transfers themselves belong in your terminal.
What guit reads locally is the last state Git recorded — an
`origin/main`-style tracking ref is reported as that stored metadata, never as
live remote state.

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

On first launch guit shows an empty Main page with one way in: **open a
repository** already on disk. It remembers what you opened and restores it
next time. Cloning is Git's job — clone in a terminal, then open the result.

The window has exactly two pages, switched by the tabs in the app bar:

| Page | What is on it |
| --- | --- |
| **Main** | The working copy, grouped into conflicts, staged, worktree and untracked files. Stage and unstage inline; the `⋯` menu on any row offers diff, open, discard or conflict resolution. Write the message and commit (with an optional **Amend**). Below the divider — draggable, and both halves keep a floor — the commit graph of the current branch, newest first, with **Load older** paging through history. Both regions are visible together; the point of the layout is that staging a file and reading the graph happen in one glance. |
| **Settings** | Theme and interface zoom, the external diff/merge/opener tools, always-on-top, the full shortcut list, an environment check (**Check again**), and **Export diagnostics…**. |

The branch chip in the app bar opens the branch and tag picker as a layer over
Main: search, create, switch, rename and delete branches, create annotated or
lightweight tags, and read the remote-tracking refs Git has recorded locally.
Destructive actions preview first. It is a temporary layer, not a third tab, so
the tab strip stays reachable while it is up.

Settings is reachable even when no repository is open, so theme, zoom and
diagnostics work from a cold start. Main is not — it shows its empty state
until you open something.

### Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `O` | Open a repository |
| `Ctrl`/`Cmd` + `R` | Refresh status |
| `Ctrl`/`Cmd` + `1` / `2` | Switch to Main / Settings |
| `Ctrl`/`Cmd` + `Enter` | Commit, from the message box |
| `Ctrl`/`Cmd` + `=` / `−` / `0` | Interface zoom in / out / reset |
| `Escape` | Close the open dialog, layer or menu |

Interface zoom is 12–24px, and the theme follows your system by default with
a manual override. Both preferences persist across restarts.

## Destructive operations are never one click

Hard resets, branch deletion and discarding changes all go
through the same path: guit computes exactly what would be affected, shows you
that list, and refuses the confirmation if the candidate set changed in the
meantime. A confirmation is single-use and dies with the process — quitting
guit mid-dialog cannot leave a pending destructive action behind for you to
walk into after a restart.

## Local only, so your credentials stay yours

**guit stores no credentials** — there is no guit-owned credential file, no
keychain entry and no in-memory cache. It goes further: because guit performs
no network operation, it never *needs* one. There is no password dialog, no
authentication retry and no askpass helper, and `GIT_TERMINAL_PROMPT=0` is set
for every `git` guit runs, so a repository with an unreachable remote is a
readable repository rather than a stuck prompt.

Your `credential.helper` configuration, your remotes and your ssh-agent are
left exactly as you set them — guit does not read them either. See
[docs/credentials.md](docs/credentials.md).

## When something goes wrong

**Export diagnostics…** in Settings → Environment & diagnostics writes a
plain-text report. It first shows you a manifest of exactly what the file
contains — versions, the Git executable location, the filesystem-watch mode,
the config file names with their sizes and schema versions, and recent event
summaries. Credentials and their configuration, remote URLs, prompt text,
commit messages and file contents are excluded by construction, and the home
directory path is folded away.

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
