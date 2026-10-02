# Changelog

All notable changes to guit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. This file is the record of what changed; what has never been verified
is stated in the entry that introduces it, and no entry claims coverage the
release it belongs to did not measure.

## [Unreleased]

### Added

- A repository menu with recent repositories, open, refresh, close session and
  branch/tag management. The backend supplies the repository's short name.
- An integrated title bar with window dragging, double-click maximise, edge
  resizing and a window menu available by right-click or Alt+Space.
- Double-click the divider between changes and history to restore its default
  height split. The divider's tooltip names this shortcut.

### Changed

- Main and Settings keep their text labels at narrow widths. The title bar
  switches to two rows when needed, keeping its four window controls together.
- Search and latest-file-modification age share the Main toolbar. The pending
  change count reserves its width from zero through 99+.
- Repository actions use the repository menu; committing and branch switching
  remain next to the content they act on.

The integrated title bar has build and source-test coverage, and its rendered
layout has been measured in a real browser engine across nine window sizes and
four interface sizes. What that does not cover is the window manager side:
window dragging, edge resizing, the native window menu, always-on-top and the
saved geometry have not yet been exercised in a running window, so no entry
here claims them verified.

### Fixed

- Linux selects X11/XWayland first for window controls, including when the
  launch environment specifies Wayland. Native Wayland remains a fallback
  when X11 is unavailable. Direct launches no longer require a terminal
  override to select X11.
- The pin now follows the window's reported state after applying a request and
  when focus changes. A request the desktop does not apply reports an error
  instead of displaying the requested state as confirmed. A failed startup
  restore preserves the saved preference for the next launch.
- Height dragging measures the changes and history regions without counting
  the search bar. Grabbing the divider away from its top edge keeps that
  offset, including when the panel has scrolled. Keyboard adjustments start
  from the displayed split when a region has reached its minimum height.
- The divider keeps its resize cursor and highlight during a drag. A cancelled
  pointer or lost pointer capture ends the drag and saves the chosen split.
- The repository name in the title bar was a 23.2px-tall target on the smallest
  window at the smallest interface size, under the 24px the four window
  controls keep. It now takes the row height beside it, so the repository menu
  is as easy to hit as the buttons next to it at every size.

## [0.0.2] - 2026-10-02

### Fixed

- Path comparison on Windows. Git reports repository paths in forward-slash
  form, the file-system watcher reports them in backslash form, and the
  standard library's canonicalization prefixes them with `\\?\`; the three did
  not always agree, so a change detected by the watcher could not be matched
  to the snapshot it belonged to and every event fell back to re-asking Git for
  the whole repository. Identity paths are now normalized once at detection,
  path equality on Windows ignores case as the file system does, and watcher
  keys are held in the same shape the snapshot uses, restoring incremental
  updates instead of full re-reads.
- Destructive writes over many paths. A single stage, unstage, discard or
  clean whose scope held more than a few hundred files could fail outright on
  Windows, where one command line is capped at 32 767 wide characters. The
  write lane now splits such a scope into batches that each fit the cap and
  reports their combined result; the same batching applies to the untracked
  listing a clean reads before it acts.
- A `git hash-object` call in the reset tests that passed every colliding path
  in one argument list, which trips the same Windows command-line cap; it is
  now fed in chunks.

### Testing

- The external-tool helper now reads a Windows empty-side path (`nul`) as empty
  content, the way it already read `/dev/null`. This turns the deleted-file
  difftool case green on Windows — one of the two continuous-integration tests
  the 0.0.1 entry recorded as red off Linux. The other, a `git mergetool`
  `trustExitCode` case, is red on macOS and passes on Windows; it is unchanged.
- Test fixtures that assumed a POSIX file system were made honest here rather
  than skipped: repository fixtures pin `core.autocrlf` off so line-ending
  rewriting cannot change a file a test is checking, two pattern-versus-filename
  cases use names NTFS will actually hold (it refuses `*`), and the Linux-only
  retry around a freshly-written stand-in `git` is gated to `cfg(unix)` so it no
  longer reads as dead code on Windows.
- Two more Windows-runner assumptions in the tests were corrected once the suite
  actually ran there. The temporary repository can arrive as an 8.3 short path
  (`RUNNER~1`) while `git rev-parse --show-toplevel` and the file-system watcher
  both answer with the long form; the activity and session fixtures now hand back
  the same long form `native_form` gives the production code, so a watch event
  matches the index instead of silently costing a Git read. And the diagnostics
  test read only `HOME`, which a Windows shell does not set, so it now resolves
  the home directory the way the redaction under test does — `HOME` or
  `USERPROFILE`.

### Known gaps at this version

- **Windows is now run and tested, not merely configured to build.** The full
  suite passes there — 418 JavaScript tests, 342 Rust tests, `cargo fmt` and
  `cargo clippy` clean — and the release executable was driven in a real window
  against a disposable repository: the saved session reopened on its own, a
  change made outside the app appeared in the list with no user action, and
  Stage and Unstage round-tripped a file with `git status` agreeing after each.
  What this does not claim: no Windows installer artifact was built or
  installed, multi-monitor and non-default scale factors were not exercised,
  and a real external diff or merge tool was not launched — those paths are
  covered by tests with a stand-in, not by a hand. macOS and the rest of the
  0.0.1 limits are unchanged.

## [0.0.1] - 2026-10-01

Runtime verification is limited to Linux (Ubuntu, GTK/WebKit); Windows and
macOS have build configuration only. This release consolidates the panel into
two tabs, brings the unified search and the clean restore, and reworks the
appearance, monitoring and file-modification surfaces. The four properties it
was first released for are unchanged: local-only, no credentials stored, no
file contents or diffs in the window, and one write lane with single-use
confirmation tickets. A "Known limits" note in the README names what a real
window exercised and what only the tests cover.

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
- The app bar's top-right corner holds the window's four actions as one group: keep it
  above other windows, minimise, maximise or restore, close. The native title bar stays,
  so these are a second way onto the same four things rather than a replacement for it,
  and there is deliberately no draggable strip in the page — a second handler for the
  double-click that maximises would undo the decoration's own. Every one is awaited: the
  button shows the desktop's answer, not the ask, so a request that is refused puts the
  control back where it was and says so out loud. Maximise reads the window's actual
  state before acting and repaints when it changes by any route, including the title bar
  being double-clicked, and the app-bar pin and the Settings row for the same setting are
  two readings of one answer, so neither can be the stale one. Close is a request to the
  window, not a second way to destroy it: it runs the same path the title bar's close
  runs, which writes the window's size and the panel's choices down before the window is
  gone, so there is exactly one place that can lose them.
- A close that would strand a running Git operation is held, and the holding says so. Every
  route onto a close — the decoration's own button, the app bar, a desktop quit key — is
  asked before anything is let go of, and while an operation is in flight the answer is a
  refusal that names it in the words the status line is already using. Nothing is written
  down or released on that path, so the panel is exactly where it was. guit does not stop
  the operation to close its window, and it does not kill it on the way out either:
  cancelling is an operation's own kill path, with its own button in the status line, its
  own death of the process group and its own report of what died, and an exit path cannot
  make that choice on someone's behalf. Going ahead is the named button the refusal shows,
  good for that one close and never for a later one, so two clicks on the same corner are
  not how a commit ends up running with nothing watching it. An open external tool does
  not hold a close: that program has its own window and its own way to finish, and it is
  not mid-way through writing anything to the repository.
- The first start of a fresh install is above other windows, because a monitoring panel
  that a maximised editor covers is not monitoring anything. It is an ordinary setting
  after that: whatever a person leaves it at is what the next start does, and a stored
  choice to not float is honoured rather than overruled by the default.
- At the narrowest width the app bar drops the three repository buttons — open, refresh,
  close session — instead of letting them squeeze the window cluster. The More menu
  repeats all three by the same words and two of them have a shortcut, so the affordance
  survives the loss of one of its copies. That is the same trade the Commit button
  already makes, and it is made in the other direction on purpose: a window button that
  loses its box loses the only place the panel itself offers to put the window away.
- Resting the pointer on a commit row — or walking to one with the arrow, Home and End
  keys — opens a bubble against that row and answers it: the full message the row cuts
  off, the author with the whole timestamp rather than the date the row shows, the
  object id in full, and which loaded branch and tag names contain that commit. The
  pointer waits a quarter of a second for its answer, which is what tells a rest on a
  row from a sweep down the list; a key press answers on the key, because pressing it
  is already the decision to read this one.
  None of that costs a Git read. Everything the bubble says is in the page already on
  screen, and the one line a row cannot answer is walked from the loaded pages. The
  question that does cost a read is "work on this one", and only a click or Enter asks
  it: measured in the panel's own renderer, twenty rows walked by key fire no file-list
  read at all, where the same twenty presses used to fire twenty. Walking past a
  commit the pane was opened for no longer moves the pane — it keeps describing the
  commit it was opened for, and its buttons belong to that commit alone.
  The box is placed, not centred: flush against its row so the pointer can travel
  between the two without crossing a gap it would fall through, flipping above the row
  when the list has no room below, and capped to the list's own box however long the
  message is. At the 340 CSS px minimum window that means a 40-character id in a 300 px
  box inside a pane inset 6 px from each edge, still touching its row. It closes when
  the pointer leaves the row or the box, when the reader scrolls the list, on Escape,
  and whenever the rows are rebuilt under it — a bubble that could no longer confirm
  its own row closes rather than following the screen position onto the next commit,
  which would read as one commit's message wearing another one's id. A scroll the panel
  caused itself is the cursor moving to a visible row, so it keeps the answer it was
  already giving.
  The bubble carries no buttons and is hidden from the screen reader: the row already
  says who and when, the full id is selectable in the box itself, and copying stays the
  detail pane's one button. What it replaces is the graph node's native tooltip and the
  two on the row's own text — the same facts, said twice in the operating system's
  layout instead of the panel's. The branch and tag chips keep their tooltips, which
  answer a different question: what kind of name this is.
- The line above the commit graph now leads with the branch whose history it is
  drawing, and is the second door onto another one. It says `main`, or
  `detached at 1a2b3c4d`, or `fresh (no commits yet)`, or `bare repository` — the
  same four sentences the app bar uses, written down in one place rather than
  remembered twice, because one state said two ways in one window is a state
  nobody can trust. A name longer than the header loses its tail rather than
  pushing the rest of the line off it (measured in the panel's own renderer: 430
  px of name drawn inside 174 px, the whole string still there to read back).
  Opening it lists the repository's local branches, answered from the very
  listing the labels on those rows were joined from, so opening the header fires
  no Git read at all. Three kinds of row are told apart: the branch already
  checked out is shown and not pickable, a branch whose bytes cannot be handed
  back to Git is said as not switchable rather than hidden, and a switchable one
  carries where it tracks and how far apart the two are. A remote-tracking name
  and a tag are not offered, because Git does not switch to either — it refuses
  them, and a panel that offered them would be offering its own refusal.
  Picking a branch is one write on the lane every write shares, bound to the
  snapshot on screen. It asks for no confirmation and never retries with force:
  switching is not a destructive operation here, and the part of it that is
  impossible is refused by Git with HEAD left where it was. Measured in the same
  renderer: the head moving costs exactly one page of history and no second
  names read, a Git refusal re-reads nothing and leaves the graph on the branch
  it was drawing, and a write the backend would not start at all is said so
  rather than drawn as a repository that has not changed.
- An untracked file can now be thrown away on its own. Its row's `⋯` menu carries a
  Delete, and the confirmation that opens binds that one path: `git clean` is asked
  for the named files and removes only the ones it agrees to remove, so dropping a
  build artifact no longer costs a confirmation over every untracked thing in the
  repository. A nested Git repository is never offered this way — Git will not list
  one without a force guit does not apply, and a path Git would not list is reported
  as not removed rather than quietly left in. The whole-repository clean keeps its own
  button and its own promise, and the confirmation stores which of the two was read,
  because a new file elsewhere in the working tree invalidates "everything untracked"
  and is none of "these three" files' business. A confirmation whose files moved is
  withdrawn instead of renewed against whatever survived — the list on screen is the
  list being promised. A row menu that outlived the state it was built in is no
  longer silent: asking for a clean while a write is running says the write is
  running, instead of looking like a click that did nothing. The two shapes of a
  clean and the row that may be deleted are decided in the file model and pinned by
  its tests; that the delete sits on the row and the heading stays a whole-repository
  clean is pinned as a claim about the sources, not measured in a drawn page — this
  stage has no changes-area rendering probe, and the Git side is measured against the
  one Linux host and Git version every other record here comes from.
- A reset now goes to the commit an abbreviation names, and says which kind of "no"
  it heard. Four hexadecimal characters are enough — that is where Git stops reading
  an id, measured in a repository of a hundred objects and one of forty thousand, and
  it is not a number any setting moves. What is acted on is always the full id Git
  answers with, so the characters typed are never the characters handed to Git, and
  an id copied out in upper case is the same commit as the same id in lower. A branch
  name, a tag name and every revision like `HEAD~1` or `@{u}` are refused before Git
  is asked, because Git is happy to accept them: a reset bound to a name would go to
  whatever that name points at when it runs, and the panel would have confirmed
  something else. Not every refusal is the same fact, and they no longer share one
  sentence. Nothing in the repository has that id; something does and it is not a
  commit; two commits share the abbreviation, and the number of them is named so the
  id can be extended until one is meant. A Git process that could not be started, an
  answer cut short by its output limit, and two Git reads that disagree about the same
  id are all reported as the panel failing to read — never as a commit that does not
  exist. Merge and rebase keep accepting branch names, because there a name is what
  the operation means. These are the backend's rules and the words behind them; the
  row that types an id into them is the entry below, which is also where the screen
  that shows them was measured — the abbreviations themselves are verified against
  the one host and Git version every other record here comes from.
- The changes area can restore the repository to a commit that was typed in, not only
  to one selected in the graph. A row under the commit message holds the field and the
  button. An abbreviation is accepted as far as it names exactly one commit, and what
  is confirmed is always the id Git resolved rather than the characters typed. Pressing
  Enter asks for the preview and never runs the restore. That preview is the whole ask:
  where HEAD moves, in the two ids Git resolved, then one heading per class of path the
  two steps touch, because what is done to them differs — tracked paths the target's
  version changes, local changes this throws away, untracked paths the restore writes
  over, ignored paths the target holds anyway, untracked paths deleted after the
  restore, and untracked paths that stay because guit does not enter another
  repository. A class with nothing in it contributes no heading, and every name is put
  on screen as the text Git named it. The confirmation is the same one-time ticket every
  other destructive action uses, so a refresh recomputes those lists and the ask has to
  be confirmed again: a target that no longer names one commit is refused before
  anything is written, a second ask is impossible while the ticket is open, and closing
  the dialog spends nothing. The typed id and an unfinished commit message outlive a
  refresh and are cleared by opening another repository and by nothing else. What is
  measured here is this surface — the six groups drawn in the order the steps do them,
  focus returning to the row that opened the dialog, a forty-path list scrolling inside
  the window instead of growing past it, and the whole ask capped against the height of
  the window it is drawn in so that a short one scrolls the ask rather than hiding the
  paths or the button under its own edge — on the one Linux host and rendering engine
  every other record here comes from. The two steps' own outcomes, a restore that ran
  one of them and not the other and which promised paths are still on disk, are
  reported and tested in the backend; the time from Enter to that list has not been
  measured end to end, and Windows and macOS remain build configuration.
- Main now carries a search field, above the changes area and the graph, and it asks
  Git rather than the rows already on screen. A message subject, a message body, a
  commit id and an author name are all matched, in any of them and by the same
  rules: contiguous letters beat scattered ones, an id is matched as an id and not as
  prose, and a letter written as a base plus a combining mark is found in the same
  word written as one code point, because both sides are composed and case-folded
  before they are compared — while what is drawn stays exactly the text Git stored.
  There is no pinyin, no translation and no semantic matching: the characters typed
  are the characters looked for. Branch and tag names are searched
  with the commits, and a name that names no commit — a tag on a tree — is shown as
  that fact instead of being offered as a jump. A remote-tracking name is labelled as
  what Git last recorded about a remote, never as the remote's current state.
- The answer says how much of the history it covers. A scan that finished and found
  nothing is the only state worded as "nothing matched"; one that reached its ceiling
  says it is not the whole history, one still walking says nothing has matched *in the
  history read so far* and offers to search further back, and a commit whose reach was
  never probed is never described as outside the branch. The rows are drawn newest
  first, as the walk found them, and the count of what the layer left out is written
  beside them.
- Picking a result changes no filter. A commit already in the loaded page is scrolled
  to and opened; one that is not is read as the start of a page, and while those rows
  are up the graph's head line says they were drawn from that commit and are not the
  branch's recent history, with a button back to the head. Every row the page carries
  stays drawn, in the graph's own topological order. A search asks one read and shares
  no lane with a write: nothing reachable from this field stages, commits, resets or
  cleans anything, and no repository is changed by searching it.
- The field waits 120 ms after the last keystroke before asking, and asks nothing at
  all while an input method is mid-composition — a half-written character is not a
  question. That wait is a number in the search model, not hidden in the view, because
  the budget it is measured against runs from the keystroke. The layer opens over the
  page the way a menu does, is closed by Escape or by a click outside it, and is walked
  with the arrow keys, Home, End and Enter. What each of those sentences may claim, and
  which answer belongs to the question on screen, are pinned by the search model's
  tests; that the field asks one read, sits in the panel and never filters the graph is
  pinned as a claim about the sources. The layer has now been drawn and measured in the
  engine the panel displays through: opening a search moved neither the changes area nor
  the graph, drew its 40 commit rows and 3 name rows over them inside the panel, and
  left the commits underneath in the graph's own order and at their own height. A result
  the loaded page already carried cost no read, flashed the one row it landed on and
  changed no other row; one it did not carry cost exactly one read, asked for the page
  that starts at that commit, and said so on the head line — which stays standing until
  the rows it describes have arrived, rather than retiring a claim about rows still on
  screen. Drawing that full window costs 0.55 ms per draw, measured as twenty draws in
  one interval. That layer has since been drawn and measured in nine real window sizes,
  from the minimum 340x400 up to 2560x1440. Opening a search moved neither the changes area
  nor the graph at any of them, never covered the bar it hangs under, and never left the
  window; the two shorter caps the stylesheet restates are each selected by a window that
  exists — the shortest at 400 and 420 px of height, the middle one at 480 and 560 px —
  rather than only being present in the CSS. What the selected cap covers is now counted as
  painted text rather than as boxes over boxes: the answer carries 40 commit rows at every
  size, of which the smallest window draws 2 and 2560x1440 draws 13, and the rows above the
  painted ones stay in that layer's own scroll rather than disappearing. The same nine sizes
  re-measured the history's head line and found nothing past the right edge at any width;
  it wraps to two lines only at the two narrowest. The wait before a question is counted
  inside the measured number instead of excluded from it: twenty keystrokes in a row produce
  twenty searches and no other read, and over three passes of twenty warm samples on a
  visible page the waiting sentence arrives within 0.9 ms after that wait ends and the first
  row within 1.5 ms. One thing this channel still cannot see is the read itself: it answers
  from a stand-in, so the time from a keystroke to a real first result carries a Git scan
  this number does not contain, and no end-to-end budget is claimed here. The host, Git
  version and browser engine behind every measurement here are the ones the rest of this
  record comes from.

### Changed

- The panel no longer describes itself by its memory where a user actually reads
  it. The welcome screen opened with "A low-resource Git client" and the packaged
  descriptions repeated it, both after the READMEs had stopped making the claim:
  the panel holds about 45 MiB of its own against roughly 130 MiB of GTK and
  WebKit that is there whether or not a repository is open. All three now say the
  same thing. A gate keeps them saying it — it scans the packaged metadata as
  well as the documents and the sources, and fails on the retired wording.
- The READMEs say what is measured instead of saying "lightweight". The panel is
  three processes sharing GTK and WebKit, and the memory it holds was being
  quoted from a sum of resident sizes, which counts that shared library text once
  per process. Measured as it is actually charged: about 45 MiB of its own and
  roughly 180 MiB for the tree. It does not grow with the size of the history —
  the same numbers on a 10-file repository and a 5,000-file one — and it does
  not drift over time. The header now names the platform that has actually been
  run, and the requirements section lists what a real window has exercised and
  what only the tests have.
- Settings is grouped by what a choice changes. The page opened with a block
  called General that held the theme, the interface zoom, the three font names,
  the age line's refresh period, always-on-top and a nine-row list of keys, so
  the custom theme box — an appearance choice like the ones above it — started
  below all of that: measured at the default 720x560 window, its heading sat at
  1024px into the page, past a first screen that ends at 962. General is now
  Appearance (a colour, a size, three faces), the theme box follows it directly,
  and the rows that are about how the panel behaves rather than how it looks
  became a Panel block of their own. The same measurement puts the appearance
  heading at 799 with the box ending at 952, and every environment probe below
  both of them: what a person came to set is what the page shows them first.
  Because that is a layout fact rather than a source fact, the desktop harness
  asserts it from the y each block's own heading reports, and it asserts the
  order rather than the scroll position — the page is taller than the window by
  design, and a check that depended on where the page happened to be scrolled
  would be a check of nothing.
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
- What that fade hides is reachable now. A wheel turned sideways, a wheel
  turned down under Shift, and the left and right arrow keys move the gutter one
  column at a time, and the line above the list names the columns on screen —
  "The graph shows columns 5–12 of 12". The pan stops with the history's own
  last column, never past it into empty width, and a row whose lanes have all
  come back inside the box stops fading. The gutter keeps that one width
  throughout, so the subject text never moves with the pan. A graph narrow
  enough to fit asks for none of it: those keys and that wheel are left to the
  list, and the line above it says nothing about columns.
- The node the pointer is over grows, so the graph acknowledges the mouse
  before the detail pane opens. A merge's ring grows and its inner dot does
  not, so the join still reads as a join.
- The ref tips that contain a commit are no longer listed by the graph node
  under the pointer. That line — the one fact about a commit its own row cannot
  say — is now the last line of the bubble over the row, and the node keeps only
  its own acknowledgement: the dot that grows. Neither says it twice, and the
  answer no longer waits on the operating system's tooltip delay and layout.
- Paging a long history reads Git once per page instead of twice. The lanes that
  run off the bottom of a page used to be settled by reading the whole history
  above that page again, in a second process, on every click; the panel now
  carries the open lanes from the page it just drew and takes the parents out of
  the records that page was read for. A boundary is continued only when it
  belongs to this session, this history generation, this pinned commit and this
  view, and only when the row at the top of the next page is one those lanes are
  waiting for — anything else re-reads the prefix, which answers the same
  question more slowly. On a 6,337-commit repository in a release build, of 127
  pages exactly one pays that second read (16.3 ms) and 126 measure 0.1 ms,
  against 20.3 ms per page measured the same way before, and the launch log
  counts one Git process per page. What it costs to remember is bounded by the
  lane cap rather than by the depth or width of a repository, and a history too
  wide for the gutter hands that fact down as it hands the lanes down, so every
  page below a fold folds the same way.
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
- The names beside a commit come from the ref listing rather than from the
  history itself. A branch that moved, or a tag created beside the current
  branch, relabels the row it now names without re-reading the history, and the
  graph and the branch picker answer for one listing rather than one each. A tag
  that names a tree or a blob is shown naming that, instead of being drawn as a
  commit. When Git refuses the listing, the list says the names could not be read
  and offers the read again — an unlabelled column is not presented as a
  repository with no branches.

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

### Removed

- The second hard reset. The detail pane beside the graph used to offer a "Reset
  hard…" of its own, and the ticket it handed out bound the target commit, the
  HEAD observed at preview time and the tracked files that were dirty — and that
  was the whole of it. A path the target's tree writes over while the working
  tree happens to hold it untracked was outside the promise, so `reset --hard`
  wrote over it with the preview silent, and an untracked directory standing
  where the target writes a file was destroyed the same way. The clean restore
  binds all of that, so this was a known way to reach a loss the panel does not
  promise, one click from a commit row. There is one reset now and it is that
  one. The two resets that move a branch and the index without overwriting
  anything — soft and mixed — stay where they were.
- The stash and linked-worktree pages, and what only they reached for. Both views
  were built for a suite of pages this panel no longer has and nothing imported
  either of them; they were also the only place fourteen commands were named, so
  those commands stayed registered on nothing but their own text. The views, the
  commands, the three backend modules behind them, and the write-lane shapes that
  existed only to serve them are gone together. The repository is still yours:
  nothing about your remotes, your stashes or your worktrees was touched, and
  `git` still does all of it.
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
- The box under the graph that looked for a commit among the rows already loaded.
  It matched only the page on screen, so a commit older than that page came back as
  absent, and it drew its graph out of the rows it left standing — a history with
  the non-matching rows taken out of it is not the branch's topology. The field
  above the panel answers "which commit" for the history instead, and it moves the
  graph rather than editing it: a hit already on screen is scrolled to, one further
  back is read as the start of a page and labelled as one. The `/` key reaches that
  field from anywhere on the Main page, except from inside a box being typed in. The
  branch picker keeps its own box, because that one asks which name out of a list
  the panel already holds.

- Two command endpoints that nothing called: one that read the stored window
  geometry (the backend already reads it directly while restoring the window)
  and one that reported credential posture (the diagnostics export reads it
  directly). Both were reachable from the webview and neither was ever used.
- A graph-layout helper that only its own tests called. Lane assignment now
  goes through the one function that does the work.

### Fixed

- Clearing the search field now stops the search it was answering, instead of
  letting it run. The scan that was walking the history kept going to the end of
  its window for a question nobody was waiting for any more. A new question
  already displaced the old one by itself; an emptied field, a closed repository
  and a closed window did not. A cancellation names one question and changes
  nothing if the panel has moved on to another.
- The commit box is no longer drawn as a row of the graph. It carried the same
  class a commit row in the history list carries, so the stylesheet's rules for a
  row — its height, its pointer, its highlight under the mouse — fell on a box of
  controls that is neither selectable nor a row. The graph's own rules are now
  named under the list that draws them.
- The restore's commit field and its button sit on the same line again at the
  narrowest window under the largest interface size. The button's label used to
  break across three lines there, and the row centred a one-line field inside a
  three-line button, so their top edges stopped agreeing. The label stays on one
  line now and the row wraps instead of squeezing the field.
- Two desktop checks were asking the wrong question, and were red on the build
  that preceded this one. The narrow-window check looked for the commit graph in
  the set of on-screen names; at 340x400 the graph sits below the fold, and the
  window reports a node as on-screen only once focus has brought it into view, so
  the check was reading a scroll position as a missing region. It now asks
  whether the graph can be reached, which it can. The other check assumed a
  fixture small enough to fit every change group on screen; the virtualised list
  is honest about not drawing the ones below the fold, and the fixture now is.
- Discarding one changed file no longer discards the files whose names happen to fit
  it. The path a confirmation binds comes out of Git's own listing, so it is a name
  and never a pattern — but Git reads an unquoted pathspec as a pattern, and
  `restore --worktree -- 's*.txt'` reverted every dirty file whose name matched. The
  preview could not show what had been taken, because it lists the paths it was asked
  about. Every pathspec guit sends is read as a literal now, measured against
  `restore`, `add` and `clean`.
- The commit draft no longer follows the panel into a second repository. Opening
  another repository left the first one's message in the box with Amend still
  ticked, and that amend would have been taken against the new HEAD. The draft
  belongs to a repository session now, so a new session starts with an empty box;
  a refresh of the repository already open still keeps what was typed.
- The app bar no longer squeezes its own icon buttons below their declared box.
  Everything else on that row carries text that is allowed to lose a tail — the
  wordmark, the repository path and the branch chip are each capped by a
  percentage and ellipsised — so when the bar ran out of width it took the
  squeeze out of the icons instead, and at the default 720x560 window a button
  declared 1.75rem square was drawn 20x29: an action whose whole box was its
  glyph plus two pixels, next to a chip cut to 38. The icons cannot shrink now,
  and the chip keeps a readable name at every width rather than only the narrow
  ones, so what gives way is the path, which still holds all of itself in its
  tooltip. The same measurement is what says the rest of the small controls are
  as designed rather than broken: a row action, a row menu button or a checkbox
  sits 20 to 23 pixels in its shortest dimension, and interface zoom moves them
  with the text — at the smallest zoom a row action is 15 tall. guit is driven
  with a pointer and promises no touchscreen, so those figures are written down
  instead of changed underfoot; the defect was the one case where a control was
  drawn smaller than its own stylesheet says it is. Verified from a separate
  worktree at the committed state: the layout probe passes at 340x400, 400x760,
  360x900 and 1400x420, the narrow-window suite still reaches every primary
  action and still closes the application on its own, and the controls it
  measures are the ones that were being squeezed.
- The commit list's head no longer pushes its own paging button off the smallest
  window. Its count, its "Mainline only" filter and its "Load older" button do not
  share a line at 340px — the button's right edge sat 21px past the viewport — and a
  row that is not allowed to break does not lose a word, it loses the box. The head
  may break where it must now, which costs the list one row of height in exactly the
  widths that need it and moves nothing at a width where the three already fit. That
  this was still here is the harness's story rather than the stylesheet's: the layout
  probe had only ever been run at the default window, so the minimum size was not a
  shape anyone had looked at until it was measured as one.
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

Stated plainly, because each of these is a limit on what this release claims.

- **Runtime verification is Linux only.** Built and driven on Ubuntu with
  GTK/WebKit. Windows and macOS are configured to build and have never been
  run, so they are not claimed to work. deb/rpm are the Linux artifacts;
  distribution beyond the verification host is untested.
- **Committing and restoring to a typed commit id are covered by tests, not
  by a click.** Both need text typed into a box, and the only channel available
  on the verification host — a Wayland session with no key-injection tool, and
  a WebKitGTK entry that exposes no `EditableText` interface — cannot type one.
  Their behaviour is pinned by the Rust suite and by a probe that drives the
  real view, but not by a hand on a real repository. Every other write path
  (unstage, discard, delete untracked) was driven end to end in a real window
  against a disposable repository and checked against `git status` and the
  files on disk.
- **Idle memory.** The panel is three processes sharing GTK and WebKit; about
  130 MiB of that is the toolkit's and is present with no repository open. On
  a repository of a few thousand files it holds roughly 45 MiB of its own and
  about 180 MiB in total, measured as proportional set size. It does not grow
  with the size of the history.
- **Multi-monitor and non-default display scale factors are unverified**, the
  verification host having one display.
- **The whole-page Tab order has no recorded pass** for the same
  key-injection reason; focus return and narrow-window reach are asserted.
- **Two continuous-integration tests fail on macOS and Windows, and did so
  before this release.** The macOS one is a `git mergetool` case where a tool
  that resolves a conflict and then exits non-zero is expected to be accepted
  unless `trustExitCode` is set; on that runner Git reports a failure instead.
  The Windows one diffs a deleted worktree file, where Git passes an empty
  remote that resolves against the device namespace rather than a path. Both
  exercise real Git behaviour on platforms this release was not run on, and are
  left as found rather than adjusted until green. The Linux job passes.
