# Changelog

All notable changes to guit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. This file is the record of what changed; `docs/known-limitations.md`
is the record of what is not verified.

## [Unreleased]

### Added

- Main answers "which file in this working tree was touched last" on a line
  above the change list. The answer is the newest modification time among the
  files Git itself counts — tracked files, plus the untracked ones Git has not
  been told to ignore — and it names the file behind that time. What it cannot
  say, it says: "at least" when the listing only covered part of the tree,
  "no working-tree files to measure" for a clean checkout with nothing of its
  own, and "last modification unknown" while a session has no measurement yet
  or the one it has cannot be trusted. A file timestamp ahead of the panel's
  clock is reported as untrustworthy rather than as an age of zero.
- That line advances on a timer of its own, every five seconds. It is the only
  thing the timer repaints: a tick reads no Git, re-renders no list and moves
  no graph, and it stops with the window.
- How often that sentence is rewritten is now a row in Settings → General,
  between one second and sixty. Changing it re-arms the one timer the panel
  already has — it never starts a second one — and takes effect immediately,
  including on the words currently on screen. A number outside that range is
  corrected to its bound and said so; a field holding no number at all is
  refused, leaving the interval already running untouched. This changes only
  how often the display talks: file changes are still detected as they happen,
  so sixty seconds of text never means sixty seconds of staleness, and one
  second never costs a Git read per second.
- Settings → General carries three font rows: a Latin text family, a Chinese text
  family and a code font. Each is a name rather than a list, because the panel
  cannot enumerate what a computer has installed; an empty row means the built-in
  stack, and the placeholder says so. Two sample lines sit under the boxes — mixed
  Chinese-and-Latin text, then an object ID and a path — and they are set in the
  panel's own two font properties, so what a person reads is the drawing, not a
  description of it. A name the panel cannot write is returned to the row it came
  from, leaving the family in force where it was and saying what happened; a code
  font this computer cannot draw with one width per character is reported too,
  because that is the panel overriding the choice rather than applying it.
- Settings has a Custom theme section: paste a fragment of CSS and the panel draws it.
  What may be in it is a subset — colours and font families, on the panel's own parts —
  and a fragment that reaches the network, moves a row or hides a control is refused
  declaration by declaration, with every refusal named rather than counted. The section
  shows the text the panel would actually draw, and what it would leave out, before
  anything is asked of the screen; applying text whose every declaration was refused
  leaves the theme that is working untouched, because losing colours you can see is not
  what pasting unreadable text asked for.
- Getting the built-in look back does not depend on the custom one. `Ctrl/Cmd + Shift + T`
  and the button on that page are the same action, and the key press is listened for on
  the window, so no stylesheet can hide it or make it not work. The other two ways a
  theme can fail are decided without asking the person: text the drawing engine has no
  value for is refused and reported, and a fragment that drew but took the controls that
  turn it off with it is reverted to the look that was reachable before, with its text
  kept in the box to be edited. In both cases the theme is switched off, and the next
  start of that window is asked to draw no theme either — so closing the window in a
  panic does not reopen it into the same wall.
- A custom theme is stored before it is drawn, and what was stored says whether the draw
  was ever confirmed. A fragment that takes a window down never reports back, so the
  only evidence the next start can act on is the marker left behind: it comes back with
  no theme, disables the fragment and says so. A start that only asked to skip themes —
  the key press above — draws nothing and changes nothing, so the theme is still there on
  the start after it.

### Changed

- The code font is measured before it is used. A family name the computer does
  not have is not skipped by the drawing engine — it substitutes some other face
  and hands back a value that still reads as the name asked for — so the panel's
  own monospace default could end up drawing an object ID with one narrow "i" and
  one wide "m" in the same column, and every path, ellipsis and short OID under it
  no longer lined up with the row above. Before writing the property, the panel now
  lays out a few glyphs of the stack it is about to use and, when a character is
  not one advance wide, writes the generic monospace instead. The cost of a name
  this computer has never heard of is therefore the look of a face the user did not
  pick, which the settings row says out loud; the alignment of the columns is not
  paid for it.
- Interface zoom and theme are stored in one versioned record rather than each in
  a key of its own. Neither row behaves differently: the choice still comes back
  after a restart, and a stored number outside the range the panel can draw is
  still corrected to its bound. What changed is what the stored text can say — it
  names the version that wrote it, an unreadable or newer record is left whole
  rather than overwritten, and a value that cannot be understood is corrected to
  the bound it fell outside of.
  The split position and the refresh interval stay in the keys their own rows write
  until they move across too, and moving one row at a time is deliberate: a
  migration that deleted a key some part of the panel still writes would cost that
  setting the next time it was changed.
- A commit graph's lane turns are one smooth curve now — level where they
  leave the node, vertical where they meet the row's edge — instead of a
  straight step through a quarter-round corner.
- The graph gutter keeps a fixed maximum width: a deep fan fades its extra
  lanes at the right edge rather than widening every row and sliding the
  subjects sideways once "Load older" reaches it.
- The node the pointer is over grows, so the graph acknowledges the mouse
  before the detail pane opens. A merge's ring grows and its inner dot does
  not, so the join still reads as a join.
- Hovering a graph node now also lists the loaded ref tips that contain the
  commit, which the row itself cannot say, instead of repeating the row's
  author and subject.
- Redrew the app icon as Git branches interlacing like guitar strings, with
  commit nodes on the strings and a shared merge node. Regenerated the desktop
  icon assets from the SVG source, with rounded diamond commit nodes, a
  two-tone merge ring, bold plum and sage strings with continuous color
  gradients into the nodes, and a softly shaded cream surface.
- Softened the icon's diamond shoulders and branch curves, tightened the
  crossing gap, and lengthened the color transitions between nodes and strings.
- The panel has two pages — Main and Settings — in a tab strip at the right of
  the app bar, and the changes area and the current branch's graph share one
  page instead of being two of the seven views an activity rail switched
  between. The repository entry is Main's empty state, and the branch picker is
  a layer over Main rather than a page of its own. `Ctrl/Cmd+1` and `+2` reach
  the two pages; the old `+3`…`+7` view switches are gone.
- The two halves of Main divide its height between themselves. The bar between
  the file list and the graph takes a drag, or the arrow and Page keys once it
  has focus, and the share you leave it at is remembered. Each half has a floor
  it cannot be dragged past; a window too short to give both their floors scrolls
  the page instead of crushing the commit footer into nothing.
- Each list re-measures itself when its own box changes — a dragged split,
  interface zoom, a narrower window — rather than only when the window was
  resized, so the rows on screen always match the height they are drawn in.
- An accepted repository snapshot no longer answers with six Git reads. Only
  what moved is read again: the commit history when the branch it is drawn from,
  or that branch's head, is a different one, and the branch and tag listing when
  the head, its ahead/behind counts or the operation in progress change — and
  only while that listing is on screen, because it reads the names again the
  moment it opens. A refresh that changed nothing you can see asks Git for
  nothing.
- A repository read now carries the identity of the session it was asked
  from, and answers with it. Opening a second repository that happens to sit
  at the same commit as the first no longer inherits the first one's commit
  page or branch listing: a read asked by a session that has closed, or after
  the thing it was reading moved, is refused by the backend and dropped by the
  panel. What stays on screen is the current repository's answer, or nothing.
- Watchers, document-level handlers and the listeners on the repository's own
  events are registered for release at the moment they are attached, and the
  releases run when the window is asked to close. Switching between the two
  pages repeatedly has been measured to leave the listener, watcher and timer
  counts exactly where they were.
- Stash, worktree and submodule management and remote management no longer have
  a page. Their commands stay registered while their entry points are retired in
  the open, so nothing is reachable by accident.
- The remote rows in the branch picker are a read-only listing now. They show
  the remote-tracking refs Git recorded locally — the last state your own `git`
  wrote down — and say so, instead of offering actions against the remote.
- A tab's pending count hangs in a gutter the tab reserves for it, so it never
  sits on top of the page's own word — not at one change, not at the `99+` the
  count caps at. Once the window is narrow enough that the words are gone, the
  gutter goes with them and the count sits on the corner of the glyph again.

### Removed

- guit does not touch the network. Cloning, fetching, pulling, pushing, force
  pushing, publishing a branch, adding or removing a remote, deleting a
  remote-tracking branch and setting a branch's upstream are gone: their entry
  points, their command registrations and their implementations left in the same
  change, so neither the window nor a hand-written call into the process layer
  can ask for one.
- The credential prompt. There is no "Retry with credentials" action, no askpass
  helper for guit to act as, and no path by which a secret could reach the
  window. Every `git` guit runs is told not to ask, so an unreachable remote is
  a read failure rather than a dialog that hangs until it times out.
- The progress streams that carried those operations — clone, sync and
  submodule-download events have no emitter left to listen for, and the settings
  probe that measured a transfer went with them.
- Submodule init and update. The submodule list is read-only; downloading a
  submodule's objects is a terminal command.
- Implicit object fetching. Submodule recursion and lazy fetching are off for
  every process guit starts, so a partial clone or a repository that is missing
  objects keeps them missing. What Git will not answer without those objects is
  reported as a failure, never as a clean tree.

### Fixed

- A part of the working tree Git could not open is no longer reported as a part
  that changed nothing. `git status` exits `0` when a directory is unreadable,
  leaves it out of its listing and puts the complaint on stderr, which nothing
  read: the files inside it simply disappeared from the panel's view of the
  repository. The read now carries whether stderr was empty, and a status that
  could not see the whole tree is refused — the snapshot is not published, and
  a destructive operation whose recheck could not see it is refused too. The
  ordinary shapes stay unaffected and are pinned as producing no stderr.
- The hand-drawn icons are drawn as strokes again. The stylesheet targeted an
  icon inside an icon, which never matched the single `svg.icon` each glyph is,
  so every icon fell back to a filled black shape.

## [0.0.1] - 2026-09-27

First public release. Runtime verification is limited to Linux; Windows and
macOS have build configuration only (see `docs/known-limitations.md`).

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

- Write and external-tool failures now use an error status in the window instead of a success status.
- A hard-reset preview refuses to proceed when Git cannot list or count the commits it would discard.
- A failed background refresh stays visible in the monitor line until a refresh succeeds, with a prompt to refresh manually.
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

### Initial feature set

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

### Packaging

- Installer metadata: publisher, license (MIT) and package descriptions.

### Known gaps at this version

- AppImage is produced and was launched on the verification host
  (Ubuntu 26.04); distribution beyond that host is untested. deb/rpm are
  the primary Linux artifacts.
- Windows/macOS: configured, not runtime-verified.
- Real-provider (GitHub/GitLab/Gitea) credential flows await a manual
  user-attended pass.
