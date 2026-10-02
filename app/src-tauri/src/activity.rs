//! Which existing working-tree file was touched last.
//!
//! The panel's activity line is the maximum filesystem modification time among
//! eligible files, which is a different question from `git status`: status
//! reports what differs from the index, this reports what the disk was doing.
//! The two share a candidate rule (Git's own ignore handling) and share nothing
//! else, so the answer is computed here, pushed over its own event channel, and
//! never folded into a snapshot.
//!
//! Candidates come from one `git ls-files` call and are then filtered by
//! `lstat`, which is also where their modification times come from. Git's
//! listing contains things that are not files — a directory holding its own
//! `.git` is listed as `inner/`, and once it is added to the index the same
//! directory is listed as `inner` with no slash — and a directory's mtime
//! answers a different question ("the set of names in here changed"), so only
//! regular files count. Nothing classifies those shapes by their bytes: a legal
//! filename can look exactly like an index record, so the filesystem is the
//! only authority on what an entry is.

use serde::Serialize;
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::repo::{self, RepoIdentity};
use crate::runner;
use crate::watch::Window;

/// The listing is one record per candidate file, so its size grows with the
/// number of files in the repository — the way `git status` output does, and
/// nothing like the commit history. A repository of a few thousand files
/// already passes the 64 KB default and would be reported as unreadable for no
/// reason, so this reads at the status bound. Past that the answer is
/// `unavailable`, never a partial one: the surviving prefix of a truncated
/// `ls-files` is unbalanced by construction (one category comes before the
/// other), so the newest file may be missing from it entirely while the read
/// still looks complete.
const ENUMERATION_OUTPUT_LIMIT: usize = runner::STATUS_OUTPUT_LIMIT;

/// A read of the whole index, bounded like the read of the whole status.
const ENUMERATION_TIMEOUT: Duration = Duration::from_secs(30);

/// What the activity line may claim about its own evidence. `scanning` and
/// `stale` are deliberately absent: the first belongs to a frontend that has
/// received nothing yet, and the second is "how long have I had no evidence",
/// which a scan always answers as fresh by construction and only a clock that
/// keeps running between scans can decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityState {
    /// Every candidate was listed and every one of them was measured.
    Ready,
    /// Measured, and there was nothing eligible to measure. A repository with
    /// no commits reaches this legitimately, so an empty listing is never a
    /// failure signal and never inferred from one.
    Empty,
    /// Some part of the repository could not be read. The number it reports
    /// covers what was read, and says so.
    Partial,
    /// No trustworthy number exists. Never rendered as an age.
    Unavailable,
}

/// Why the answer is not a plain maximum. Typed rather than a sentence because
/// Git's own wording follows its locale and its version, and the text a user
/// reads is the frontend's to own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityReason {
    /// Git exited non-zero, or could not be started.
    ReadFailed,
    /// The listing reached [`ENUMERATION_OUTPUT_LIMIT`].
    OutputLimit,
    /// Something is there that this scan could not measure, so the maximum it
    /// reports may be missing the newest file in the repository.
    UnreadablePaths,
    /// The snapshot for this round failed to be read, so the index was never
    /// consulted at all.
    RefreshFailed,
    /// The session ended; nothing is claimed about any repository.
    SessionClosed,
}

/// One pushed value on the activity channel.
///
/// Timestamps are epoch milliseconds, not formatted strings: the frontend
/// recomputes an age every tick and must not parse to do it. The age is a
/// wall-clock difference, so a file really does get older while nobody touches
/// it, and a clock jump forward is correct behaviour rather than a bug.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityView {
    /// The session this was measured for, taken from the snapshot published in
    /// the same round. `None` is the identity-free form, used only to clear: a
    /// value that names no session cannot be attributed to a repository, and
    /// that is precisely why the frontend may accept it unconditionally.
    pub session_id: Option<u64>,
    /// Bumps once per measurement. Not a snapshot field and not a read's
    /// generation: it counts changes of this index alone.
    pub generation: u64,
    pub state: ActivityState,
    /// Maximum modification time among eligible files that exist and could be
    /// measured. Present only with a state that has a number to show.
    pub latest_modified_at: Option<i64>,
    /// When this measurement finished.
    pub observed_at: i64,
    /// Lossy display name of the file behind `latest_modified_at`. It cannot be
    /// turned back into a path and nothing may try.
    pub display_name: Option<String>,
    pub reason: Option<ActivityReason>,
}

impl ActivityView {
    /// A push that claims no number, no session and no generation: the clear
    /// that closes the activity line when the loop stops outside a session.
    pub fn cleared(reason: ActivityReason) -> Self {
        Self {
            session_id: None,
            generation: 0,
            state: ActivityState::Unavailable,
            latest_modified_at: None,
            observed_at: now_millis(),
            display_name: None,
            reason: Some(reason),
        }
    }
}

/// Modification times keyed by repository-relative path, with its largest
/// entry kept addressable without a search.
///
/// The cached maximum is the point: measuring a file is a comparison, and only
/// losing the file that *holds* the maximum can cost a walk. A design that
/// re-derived the maximum per event would pay a full scan per keystroke in a
/// large repository. `note` is therefore the operation this type is judged by,
/// and the entries it collects are what an incremental update later replaces
/// one path at a time instead of re-enumerating.
#[derive(Debug, Default)]
pub struct MtimeIndex {
    entries: HashMap<OsString, i64>,
    newest: Option<(OsString, i64)>,
}

impl MtimeIndex {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Record a measured file. Never searches: the new value either becomes the
    /// maximum or it does not, and both answers cost one comparison and one
    /// insert. Equal timestamps resolve to the greater path so the displayed
    /// name does not depend on the order the listing came back in.
    ///
    /// The return value says when that shortcut no longer holds — the path
    /// recorded *is* the cached maximum and its new value is smaller. A checkout,
    /// a revert or a tool that preserves timestamps can move a file's mtime
    /// backwards, and then the answer is elsewhere in the table.
    pub fn note(&mut self, path: OsString, mtime: i64) -> bool {
        let maximum_fell = self.newest.as_ref().is_some_and(|(best_path, best_mtime)| {
            best_path.as_os_str() == path && mtime < *best_mtime
        });
        let becomes_newest = match &self.newest {
            None => true,
            Some((best_path, best)) => (mtime, path.as_os_str()) >= (*best, best_path.as_os_str()),
        };
        if becomes_newest {
            self.newest = Some((path.clone(), mtime));
        }
        self.entries.insert(path, mtime);
        maximum_fell
    }

    pub fn latest(&self) -> Option<i64> {
        self.newest.as_ref().map(|(_, mtime)| *mtime)
    }

    pub fn latest_path(&self) -> Option<&OsStr> {
        self.newest.as_ref().map(|(path, _)| path.as_os_str())
    }

    /// Discard everything ahead of a fresh enumeration.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.newest = None;
    }

    /// Whether this path was listed by the enumeration that built the index.
    /// It is the question that decides whether a window can be answered without
    /// Git: a name the enumeration never produced may be a new file, a
    /// directory, or a file Git is told to ignore, and `lstat` cannot tell those
    /// apart either.
    fn contains(&self, path: &OsStr) -> bool {
        self.entries.contains_key(path)
    }

    /// Drop one path and everything below it. The window does not say whether a
    /// vanished name was a file or a directory, so both are tried: an exact key
    /// and every key that has it as a directory prefix. The comparison is by
    /// path component, so removing `dir` cannot also remove a sibling named
    /// `dir-2`. Returns whether the cached maximum was among what went.
    fn evict(&mut self, path: &OsStr) -> bool {
        let prefix = Path::new(path);
        let held = &self.newest;
        let mut lost = false;
        self.entries.retain(|key, _| {
            let gone = Path::new(key).starts_with(prefix);
            if gone && held.as_ref().is_some_and(|(best, _)| best == key) {
                lost = true;
            }
            !gone
        });
        lost
    }

    /// Re-derive the maximum after a loss. This is the only operation on the
    /// index that walks the whole table, and it is what `note`'s single
    /// comparison buys: it happens when the file holding the answer is gone or
    /// has moved backwards, not when some other file was written.
    fn rebuild_newest(&mut self) {
        let mut best: Option<(&OsString, i64)> = None;
        for (path, mtime) in &self.entries {
            let take = match best {
                None => true,
                Some((best_path, best_mtime)) => {
                    (*mtime, path.as_os_str()) >= (best_mtime, best_path.as_os_str())
                }
            };
            if take {
                best = Some((path, *mtime));
            }
        }
        let rebuilt = best.map(|(path, mtime)| (path.clone(), mtime));
        self.newest = rebuilt;
    }
}

/// The refresh loop's own copy of the index: one owner, no lock, born with the
/// session and dropped with it.
#[derive(Debug, Default)]
pub struct ActivityTracker {
    index: MtimeIndex,
    generation: u64,
    /// Whether an enumeration has ever built this index. Until it has, a window
    /// cannot be answered by amending nothing: the panel has not asked Git what
    /// the candidates are, and reporting an empty working tree out of that
    /// silence is the false-clean shape this codebase refuses.
    measured: bool,
    /// How many rounds paid for a Git enumeration, and how many lost the file
    /// that held the maximum. Both are counted because both are claims about
    /// cost that a test, not a review, has to keep true.
    #[allow(dead_code)]
    enumerations: u64,
    #[allow(dead_code)]
    rebuilds: u64,
    ignore: ExternalIgnore,
}

/// The one ignore source that lives outside the repository, and therefore
/// outside the watch set. `core.excludesFile` and the XDG default path are read
/// by Git on every enumeration, so no event has to name them for the *rules* to
/// apply — only for guit to notice that they moved. Watching their parent
/// directories was measured to cost an inotify watch per directory under the
/// user's home, shared with the panel's own budget, and a missing path silently
/// never comes back; a `stat` of the resolved path costs neither.
#[derive(Debug, Default)]
struct ExternalIgnore {
    /// The path this probe compares, once Git has been asked what it is.
    path: Option<PathBuf>,
    /// Whether that question has been asked. Without it, a machine with no home
    /// directory would pay one Git process per round for a permanent answer.
    asked: bool,
    /// Modification time and size of the last observation, used only to answer
    /// "did the same path change". `None` means "did not exist".
    stamp: Option<(i64, u64)>,
    /// The path moved, so the value Git gives for `core.excludesFile` has to be
    /// asked again: the file that changed may have been the configuration that
    /// points at it.
    stale: bool,
    /// The probe could not read what it pointed at, which means the candidate
    /// set was built without rules guit cannot see.
    unreadable: bool,
}

impl ActivityTracker {
    /// Answer one round of the refresh loop with the paths that window named.
    ///
    /// The window decides which of two costs this pays. A name the last
    /// enumeration already listed is a file this round can settle with one
    /// `lstat` and one comparison. A name it never listed — a new file, a
    /// directory, the far side of a rename, anything whose ignore status has
    /// never been asked — cannot be classified by looking at it, and costs one
    /// enumeration; adding it blindly would put a file Git excludes into the
    /// age. The index walk that re-derives the maximum is the third cost, and
    /// the only thing it is ever paid for: a candidate leaving, or the file
    /// holding the answer moving backwards.
    ///
    /// Everything else about the round is the same as a re-measurement's: a
    /// state that says how far the number reaches, never an error the caller has
    /// to guess a rendering for.
    pub fn apply(
        &mut self,
        window: &Window,
        identity: &RepoIdentity,
        session_id: u64,
        cancelled: &AtomicBool,
    ) -> ActivityView {
        let started = Instant::now();
        self.generation += 1;
        // The identity holds native-form paths (see `util::native_form`); a
        // second `canonicalize` here would re-add the `\\?\` prefix that
        // watcher events do not carry, and every prefix comparison would
        // silently fail.
        let work_root = identity.work_dir().ok().map(|root| root.to_path_buf());
        let view = match &work_root {
            // A bare repository has no working tree to amend a record of, and
            // saying so is a one-line answer rather than a walk.
            None => self.rescan_inner(identity, session_id, cancelled),
            Some(root) => {
                let git_dirs = [identity.git_dir.as_path(), identity.common_dir.as_path()];
                let moved = self.probe_external_ignore(root, cancelled);
                let reading = self.plan(window, root, git_dirs);
                if matches!(reading, Reading::Rules) {
                    // The rules moved, so the file they live in may have moved
                    // with them. The next round asks Git again about it.
                    self.ignore.stale = true;
                }
                match reading {
                    Reading::Amend(updates)
                        if !window.is_incomplete() && !moved && self.measured =>
                    {
                        self.amend(window, &updates, root, git_dirs, session_id)
                    }
                    _ => self.rescan_inner(identity, session_id, cancelled),
                }
            }
        };
        crate::perf::mark("activity.apply", started.elapsed());
        view
    }

    /// Re-enumerate the repository and re-measure it. Everything the read can
    /// mean — a listing that failed, a listing that was too long, a directory
    /// Git could not open, a file that could not be measured — comes back as a
    /// state rather than an error, because "we cannot tell" is the answer the
    /// panel has to be able to show.
    fn rescan_inner(
        &mut self,
        identity: &RepoIdentity,
        session_id: u64,
        cancelled: &AtomicBool,
    ) -> ActivityView {
        let work_root = match identity.work_dir() {
            Ok(root) => root,
            // A bare repository has no working tree to measure, which is the
            // one honest instance of "nothing eligible" rather than a failure.
            Err(_) => {
                self.index.clear();
                return self.view(Some(session_id), ActivityState::Empty, None);
            }
        };
        let listing = match enumerate(work_root, cancelled) {
            Ok(listing) => {
                self.enumerations += 1;
                // From here on the index is a statement about what Git considers
                // a candidate, which is what lets a later round amend it instead
                // of asking again. A round that never got a listing has not
                // earned that trust.
                self.measured = true;
                listing
            }
            Err(reason) => {
                // An unreadable listing says nothing about which files exist,
                // so the index is dropped rather than kept showing a number
                // this round could not confirm.
                self.index.clear();
                return self.view(Some(session_id), ActivityState::Unavailable, Some(reason));
            }
        };
        self.index.clear();
        let mut unreadable = false;
        let stat_started = Instant::now();
        for raw in listing.paths {
            // Bytes all the way down: a name that cannot be decoded is still a
            // file, and routing it through `String` would drop that candidate
            // without any signal — possibly the newest one.
            let Ok(key) = crate::write::raw_to_os(&raw) else {
                unreadable = true;
                continue;
            };
            match std::fs::symlink_metadata(work_root.join(&key)) {
                Ok(metadata) if metadata.file_type().is_file() => match metadata.modified() {
                    Ok(mtime) => {
                        // A fresh table is built in listing order, so the maximum
                        // can only rise here.
                        self.index.note(key, epoch_millis(mtime));
                    }
                    Err(_) => unreadable = true,
                },
                // A directory, a gitlink, a socket: the listing says what Git
                // knows, the filesystem says what kind of thing it is.
                Ok(_) => {}
                // Gone — a tracked file deleted and not yet staged, or one a
                // sparse checkout never wrote. A normal repository state, so it
                // must not be mistaken for an unreadable one, which would leave
                // every sparse repository looking partial forever.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                // Present, eligible, unmeasurable, and it could be the newest
                // file in the tree: that makes the answer partial rather than
                // merely shorter.
                Err(_) => unreadable = true,
            }
        }
        crate::perf::mark("activity.stat", stat_started.elapsed());
        // Git opens what it can, leaves the rest out of the listing, and exits
        // 0. Whether it had anything to say is the only distinction it offers:
        // the text is Git's, and the first line of it carries no prefix.
        let partial = unreadable || listing.warned || self.ignore.unreadable;
        let state = if partial {
            ActivityState::Partial
        } else if self.index.is_empty() {
            ActivityState::Empty
        } else {
            ActivityState::Ready
        };
        let reason = partial.then_some(ActivityReason::UnreadablePaths);
        self.view(Some(session_id), state, reason)
    }

    /// What one window obliges this round to do.
    fn plan(&self, window: &Window, work_root: &Path, git_dirs: [&Path; 2]) -> Reading {
        // A rule source is never just another file: it decides which names the
        // enumeration would have produced, so it is asked again rather than
        // measured. Both sets carry it — deleting a `.gitignore` moves the rules
        // exactly as writing one does.
        for path in window.changed().union(window.removed()) {
            if is_rule_source(path, work_root, git_dirs) {
                return Reading::Rules;
            }
        }
        let mut updates = Vec::with_capacity(window.changed().len());
        for path in window.changed() {
            if is_git_internal(path, git_dirs) {
                // Git's own metadata can justify a fresh snapshot; it is not a
                // working-tree file and must never enter the age.
                continue;
            }
            let Some(key) = relative(path, work_root) else {
                return Reading::Enumerate;
            };
            if !self.index.contains(&key) {
                return Reading::Enumerate;
            }
            updates.push((path.clone(), key));
        }
        Reading::Amend(updates)
    }

    /// Apply a window to the index without asking Git anything.
    fn amend(
        &mut self,
        window: &Window,
        updates: &[(PathBuf, OsString)],
        work_root: &Path,
        git_dirs: [&Path; 2],
        session_id: u64,
    ) -> ActivityView {
        let mut unreadable = self.ignore.unreadable;
        let mut lost = false;
        for (path, key) in updates {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_file() => match metadata.modified() {
                    Ok(mtime) => {
                        lost |= self.index.note(key.clone(), epoch_millis(mtime));
                    }
                    Err(_) => unreadable = true,
                },
                // A candidate that is not a file any more has left the set,
                // whether it became a directory, a symlink or nothing at all.
                Ok(_) => lost |= self.index.evict(key),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    lost |= self.index.evict(key)
                }
                Err(_) => unreadable = true,
            }
        }
        for path in window.removed() {
            if is_git_internal(path, git_dirs) {
                continue;
            }
            let Some(key) = relative(path, work_root) else {
                continue;
            };
            // The window never says whether a vanished name was a file or a
            // directory, and an event for the directory is the only news about
            // everything it held: evict both the name and its subtree.
            lost |= self.index.evict(&key);
        }
        if lost {
            self.rebuilds += 1;
            self.index.rebuild_newest();
        }
        let state = if unreadable {
            ActivityState::Partial
        } else if self.index.is_empty() {
            ActivityState::Empty
        } else {
            ActivityState::Ready
        };
        self.view(
            Some(session_id),
            state,
            unreadable.then_some(ActivityReason::UnreadablePaths),
        )
    }

    /// Compare the one ignore source that lives outside the repository, so
    /// outside the watch set. One `stat`, no Git process.
    fn probe_external_ignore(&mut self, work_root: &Path, cancelled: &AtomicBool) -> bool {
        if !self.ignore.asked || self.ignore.stale {
            self.ignore.path = resolve_external_ignore(work_root, cancelled);
            self.ignore.asked = true;
            self.ignore.stamp = None;
            self.ignore.stale = false;
        }
        let Some(path) = self.ignore.path.as_deref() else {
            // Nothing to compare: no configured file and no home to hold the
            // default. That is "there is no global ignore", not a failure.
            return false;
        };
        self.ignore.unreadable = false;
        match std::fs::metadata(path) {
            Ok(metadata) => {
                let seen = metadata
                    .modified()
                    .ok()
                    .map(|mtime| (epoch_millis(mtime), metadata.len()));
                if seen == self.ignore.stamp {
                    false
                } else {
                    self.ignore.stamp = seen;
                    true
                }
            }
            // Absent is a state, not an error: no global rules apply, and the
            // enumeration that follows will simply not have any.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.ignore.stamp.take().is_some()
            }
            // There and unreadable, so Git applied rules this panel cannot see.
            // The number still covers what was measured, which is exactly what
            // `partial` is for.
            Err(_) => {
                self.ignore.unreadable = true;
                false
            }
        }
    }

    /// The value for a round that never consulted the index: the snapshot
    /// itself failed to be read. Nothing is carried forward from the last
    /// success, because a number that only grows stale is how a broken panel
    /// comes to look like an idle repository.
    pub fn unavailable(&mut self, reason: ActivityReason) -> ActivityView {
        self.generation += 1;
        self.index.clear();
        ActivityView {
            session_id: None,
            generation: self.generation,
            state: ActivityState::Unavailable,
            latest_modified_at: None,
            observed_at: now_millis(),
            display_name: None,
            reason: Some(reason),
        }
    }

    fn view(
        &self,
        session_id: Option<u64>,
        state: ActivityState,
        reason: Option<ActivityReason>,
    ) -> ActivityView {
        // `Empty` and `Unavailable` have no number to show, so they get no name
        // either; a state that never carries a file is a state the panel cannot
        // misattribute one to.
        let shows_age = matches!(state, ActivityState::Ready | ActivityState::Partial);
        let latest_modified_at = if shows_age { self.index.latest() } else { None };
        let display_name = if shows_age {
            self.index
                .latest_path()
                .map(|path| path.to_string_lossy().into_owned())
        } else {
            None
        };
        ActivityView {
            session_id,
            generation: self.generation,
            state,
            latest_modified_at,
            observed_at: now_millis(),
            display_name,
            reason,
        }
    }
}

/// What one window obliges the round to do.
enum Reading {
    /// Every changed name is already a candidate, so the answer is a comparison
    /// per file and no Git process.
    Amend(Vec<(PathBuf, OsString)>),
    /// A name this index has never seen cannot be classified by looking at it:
    /// it may be a new file, a directory, or a file Git is told to ignore.
    Enumerate,
    /// The rules themselves moved, which changes the candidate set rather than a
    /// measurement of it.
    Rules,
}

/// A path whose contents decide which names the enumeration produces. `.gitignore`
/// belongs to the working tree at any depth, `info/exclude` and `config` to the
/// repository's own directories — including the shared one a linked worktree
/// reads through.
fn is_rule_source(path: &Path, work_root: &Path, git_dirs: [&Path; 2]) -> bool {
    if path.file_name().is_some_and(|name| name == ".gitignore") {
        return path.starts_with(work_root);
    }
    git_dirs
        .into_iter()
        .any(|dir| path == dir.join("info").join("exclude") || path == dir.join("config"))
}

/// Whether the path is Git's own bookkeeping. Those events refresh the snapshot
/// and nothing else: `.git/objects` is not a working-tree file, and counting it
/// would make a commit look like an edit.
fn is_git_internal(path: &Path, git_dirs: [&Path; 2]) -> bool {
    git_dirs.iter().any(|dir| path.starts_with(dir))
}

/// The index key for a path this module produced itself. `None` for a path that
/// is not inside the work root — a name outside the repository cannot be one of
/// its entries, and guessing would be worse than asking again.
fn relative(path: &Path, work_root: &Path) -> Option<OsString> {
    let stripped = path.strip_prefix(work_root).ok()?;
    if stripped.as_os_str().is_empty() {
        return None;
    }
    #[cfg(windows)]
    // Git enumerates candidates with '/' separators no matter what the
    // filesystem uses; an event-derived key has to reach the same shape or
    // every nested name looks unknown and costs an enumeration.
    return Some(OsString::from(
        stripped.as_os_str().to_string_lossy().replace('\\', "/"),
    ));
    #[cfg(not(windows))]
    Some(stripped.as_os_str().to_os_string())
}

/// Ask Git which file outside the repository carries its ignore rules. `--null`
/// keeps a value containing a newline whole, and the leading `~` is expanded the
/// way Git expands it rather than the way a caller might guess.
fn resolve_external_ignore(work_root: &Path, cancelled: &AtomicBool) -> Option<PathBuf> {
    let mut command = repo::user_git_command(work_root);
    command.args(["config", "--get", "--null", "core.excludesFile"]);
    let output = runner::run_with_limit(
        command,
        cancelled,
        Duration::ZERO,
        CONFIG_TIMEOUT,
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )
    .ok()?;
    // `git config` exits 1 for a key that is simply not set, which is the
    // ordinary case rather than a failure worth reporting.
    let configured = output
        .status
        .success()
        .then(|| {
            output
                .stdout
                .split(|byte| *byte == 0)
                .next()
                .filter(|value| !value.is_empty())
                .and_then(|value| crate::write::raw_to_os(value).ok())
        })
        .flatten();
    match configured {
        Some(value) => {
            let text = Path::new(&value);
            match text
                .strip_prefix("~")
                .ok()
                .filter(|rest| !rest.as_os_str().is_empty())
            {
                Some(rest) => home_dir().map(|home| home.join(rest)),
                None => Some(PathBuf::from(value)),
            }
        }
        // Git's own default, including the XDG override of it.
        None => std::env::var_os("XDG_CONFIG_HOME")
            .or_else(|| home_dir().map(|home| home.join(".config").into_os_string()))
            .map(|base| Path::new(&base).join("git").join("ignore")),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// A configuration read answers in milliseconds or not at all.
const CONFIG_TIMEOUT: Duration = Duration::from_secs(10);

/// What one enumeration learned, before any of it became a number.
struct Listing {
    paths: Vec<Vec<u8>>,
    /// Git wrote to stderr while still exiting 0.
    warned: bool,
}

/// The candidate set: tracked files plus the untracked ones Git does not
/// ignore, in a single process. `--exclude-standard` is what makes the ignore
/// rules apply at all; `--directory` is what must stay off, because it folds an
/// untracked directory into one entry that this module would then have to throw
/// away — while leaving the files inside it uncounted. `--stage` is off for a
/// sharper reason: a legal filename can be byte-identical to an index record,
/// so the two segments of that output cannot be told apart by a reader that is
/// not parsing Git's format.
fn enumerate(work_root: &Path, cancelled: &AtomicBool) -> Result<Listing, ActivityReason> {
    let mut command = repo::user_git_command(work_root);
    // Top-level, before the subcommand, exactly as the status read does it:
    // besides not touching the index opportunistically, this stops Git from
    // creating and removing `.git/index.lock`, whose events would otherwise
    // feed the watcher that triggers this very scan.
    command.args(["--no-optional-locks"]);
    command.args([
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
    ]);
    let output = runner::run_with_limit(
        command,
        cancelled,
        Duration::ZERO,
        ENUMERATION_TIMEOUT,
        ENUMERATION_OUTPUT_LIMIT,
        |_, _| {},
    )
    .map_err(|_| ActivityReason::ReadFailed)?;
    if !output.status.success() {
        return Err(ActivityReason::ReadFailed);
    }
    if output.truncated {
        return Err(ActivityReason::OutputLimit);
    }
    Ok(Listing {
        // `-z` is the only form that does not escape, so a name with a newline,
        // a quote or invalid UTF-8 in it comes back as the bytes it is.
        paths: output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| path.to_vec())
            .collect(),
        warned: !output.stderr.is_empty(),
    })
}

/// Milliseconds from the epoch, signed. Pre-1970 timestamps exist on real
/// disks; clamping them to zero would render as an age of decades rather than
/// as the oddity it is.
fn epoch_millis(time: SystemTime) -> i64 {
    fn clamp(span: u128) -> i64 {
        i64::try_from(span).unwrap_or(i64::MAX)
    }
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => clamp(since.as_millis()),
        Err(before) => -clamp(before.duration().as_millis()),
    }
}

fn now_millis() -> i64 {
    epoch_millis(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// `File::set_modified` is the only way a test can say "this file is from
    /// 2023" without sleeping, and every expectation below is a number the
    /// fixture wrote, not a number the clock happened to show.
    fn stamp(path: &Path, millis: i64) {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("stamp target");
        let at = if millis >= 0 {
            UNIX_EPOCH + Duration::from_millis(millis as u64)
        } else {
            UNIX_EPOCH - Duration::from_millis(millis.unsigned_abs())
        };
        file.set_modified(at).expect("stamp");
    }

    /// Files with fixed ages, because an unstamped file is a file whose
    /// modification time the test cannot name. A file the fixture wants to be
    /// *newer than everything* is deliberately created outside this helper so
    /// its live mtime is the thing under test.
    fn repository(files: &[(&str, i64)]) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        repo::git_with(&repo, &[], &["init", "-q"]);
        repo::git_with(&repo, &[], &["config", "core.autocrlf", "false"]);
        for (name, millis) in files {
            let path = repo.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, b"body\n").unwrap();
            stamp(&path, *millis);
        }
        (root, repo)
    }

    fn track(repo: &Path, message: &str) {
        repo::git_with(repo, &[], &["add", "-A"]);
        repo::git_with(repo, &[], &["commit", "-qm", message]);
    }

    /// One round with nothing to say about paths, which is what the first round
    /// of a session always is: the tracker has never enumerated, so there is no
    /// index for a window to amend.
    fn scan(repo: &Path) -> ActivityView {
        Rounds::new(repo).first()
    }

    /// A tracker held across rounds, which is the only way to ask what a round
    /// *cost*: the shipped owner lives on the refresh loop's stack and the
    /// answer to "did that file need Git" is a counter on it.
    struct Rounds {
        identity: RepoIdentity,
        tracker: ActivityTracker,
    }

    impl Rounds {
        fn new(repo: &Path) -> Rounds {
            Rounds {
                identity: repo::detect(repo).expect("test repository"),
                tracker: ActivityTracker::default(),
            }
        }

        fn first(&mut self) -> ActivityView {
            self.tracker.apply(
                &Window::default(),
                &self.identity,
                1,
                &AtomicBool::new(false),
            )
        }

        /// A watch round that names the paths it saw.
        fn named(&mut self, changed: &[PathBuf], removed: &[PathBuf]) -> ActivityView {
            let window = Window::naming(changed, removed);
            self.tracker
                .apply(&window, &self.identity, 1, &AtomicBool::new(false))
        }

        /// A round naming exactly one path: what saving a file inside the
        /// repository arrives as.
        fn saved(&mut self, path: &Path) -> ActivityView {
            let names = [path.to_path_buf()];
            self.named(&names, &[])
        }

        /// A poll tick or a watch fallback: something moved, and which paths is
        /// no longer known.
        fn blind(&mut self) -> ActivityView {
            self.tracker.apply(
                &Window::without_detail(),
                &self.identity,
                1,
                &AtomicBool::new(false),
            )
        }
    }

    const OLD: i64 = 1_700_000_000_000;
    const NEWER: i64 = 1_700_000_060_000;
    const FUTURE: i64 = 1_800_000_000_000;

    #[test]
    fn a_measured_repository_reports_the_newest_file() {
        let (_root, repo) = repository(&[("older.txt", OLD), ("newest.txt", NEWER)]);
        track(&repo, "base");
        let view = scan(&repo);
        assert_eq!(view.state, ActivityState::Ready);
        assert_eq!(view.latest_modified_at, Some(NEWER));
        assert_eq!(view.display_name.as_deref(), Some("newest.txt"));
        assert_eq!(view.session_id, Some(1));
        assert_eq!(view.generation, 1);
        assert_eq!(view.reason, None);
        assert!(view.observed_at > OLD, "observed at is now, not then");
    }

    /// The untracked half of the candidate set, and the ignore rules that
    /// decide it. `.gitignore` itself is a candidate: it is a file in the tree.
    #[test]
    fn ignored_files_are_not_candidates_and_the_rules_are_theirs() {
        let (_root, repo) = repository(&[(".gitignore", OLD), ("tracked.txt", OLD)]);
        track(&repo, "base");
        std::fs::create_dir_all(repo.join("build")).unwrap();
        std::fs::write(repo.join("build/artifact.o"), b"body\n").unwrap();
        stamp(&repo.join("build/artifact.o"), FUTURE);
        std::fs::write(repo.join(".gitignore"), b"build/\n").unwrap();
        // Rewriting the rule moved the file's mtime to now, which would make
        // the newest thing here the ignore file rather than the fixture.
        stamp(&repo.join(".gitignore"), OLD);
        let view = scan(&repo);
        assert_eq!(view.state, ActivityState::Ready);
        assert_eq!(
            view.latest_modified_at,
            Some(OLD),
            "an ignored file is the newest thing here and must not count"
        );
    }

    /// A directory holding its own repository is listed as `inner/` while it is
    /// unadded and as `inner` once it is a gitlink — two byte paths for one
    /// thing, neither of them a file. A directory's mtime moves whenever a name
    /// is added, so this is also the test that a fresh name in a sub-repository
    /// does not reach the age line.
    #[test]
    fn a_nested_repository_is_never_a_candidate_added_or_not() {
        let (_root, repo) = repository(&[("top.txt", OLD)]);
        track(&repo, "base");
        std::fs::create_dir_all(repo.join("inner")).unwrap();
        repo::git_with(&repo.join("inner"), &[], &["init", "-q"]);
        std::fs::write(repo.join("inner/own.txt"), b"body\n").unwrap();
        repo::git_with(&repo.join("inner"), &[], &["add", "-A"]);
        repo::git_with(&repo.join("inner"), &[], &["commit", "-qm", "inner base"]);
        // The sub-repository has to hold a commit before Git will record it as
        // a gitlink at all: an empty one is refused outright, so this is the
        // only embedded shape a user can actually end up with.
        let unadded = scan(&repo);
        assert_eq!(unadded.state, ActivityState::Ready);
        assert_eq!(
            unadded.latest_modified_at,
            Some(OLD),
            "a directory touched moments ago is not a modified file"
        );
        assert_eq!(unadded.display_name.as_deref(), Some("top.txt"));

        repo::git_with(&repo, &[], &["add", "-f", "inner"]);
        let added = scan(&repo);
        assert_eq!(
            added.latest_modified_at,
            Some(OLD),
            "adding a nested repository must not import its directory mtime"
        );
        // A new name inside the sub-repository is exactly the event whose
        // consequence this rule avoids: it moves the directory's mtime, and
        // nothing else.
        std::fs::write(repo.join("inner/loose.txt"), b"body\n").unwrap();
        assert_eq!(
            scan(&repo).latest_modified_at,
            Some(OLD),
            "a touched gitlink directory is the contamination this rule prevents"
        );
    }

    /// Tracked and absent is what sparse checkout produces on purpose.
    #[test]
    fn a_tracked_file_that_is_not_on_disk_is_skipped_not_a_failure() {
        let (_root, repo) = repository(&[("here.txt", OLD), ("away.txt", NEWER)]);
        track(&repo, "base");
        std::fs::remove_file(repo.join("here.txt")).unwrap();
        std::fs::remove_file(repo.join("away.txt")).unwrap();
        // Nothing eligible is left on disk, and nothing about that is a read
        // failure: `Empty`, not `Partial`.
        let view = scan(&repo);
        assert_eq!(view.state, ActivityState::Empty);
        assert_eq!(view.latest_modified_at, None);
        assert_eq!(view.display_name, None);
        assert_eq!(view.reason, None);
    }

    /// A brand-new repository has an empty index, exit code 0 and no output.
    /// None of those three facts means the read failed.
    #[test]
    fn an_unborn_index_is_empty_not_broken() {
        let (_root, repo) = repository(&[]);
        let view = scan(&repo);
        assert_eq!(view.state, ActivityState::Empty);
        assert_eq!(view.reason, None);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_exists_but_cannot_be_measured_makes_the_answer_partial() {
        use std::os::unix::fs::PermissionsExt;
        let (_root, repo) = repository(&[("dir/inside.txt", OLD), ("other.txt", NEWER)]);
        track(&repo, "base");
        let unreadable = repo.join("dir");
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
        let view = scan(&repo);
        // Restored before the assertions: a failing test must not strand the
        // fixture with a directory nobody can remove.
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(view.state, ActivityState::Partial);
        assert_eq!(view.reason, Some(ActivityReason::UnreadablePaths));
        assert!(
            view.latest_modified_at.is_some(),
            "a partial answer still reports what it read"
        );
    }

    /// The name is not valid UTF-8, so a scan that routed candidates through
    /// `String` would lose the newest file in the repository silently.
    #[cfg(unix)]
    #[test]
    fn a_name_that_is_not_valid_utf_8_is_still_a_candidate() {
        use std::os::unix::ffi::OsStrExt;
        let (_root, repo) = repository(&[("plain.txt", OLD)]);
        let odd = PathBuf::from(OsStr::from_bytes(b"bad\xff.txt"));
        std::fs::write(repo.join(&odd), b"body\n").unwrap();
        stamp(&repo.join(&odd), FUTURE);
        track(&repo, "base");
        let view = scan(&repo);
        assert_eq!(view.state, ActivityState::Ready);
        assert_eq!(
            view.latest_modified_at,
            Some(FUTURE),
            "the undecodable name holds the newest mtime"
        );
        assert_eq!(
            view.display_name.as_deref(),
            Some("bad\u{fffd}.txt"),
            "the display name is lossy, and that is the only thing lossy about it"
        );
    }

    /// A read that Git could not do is a failure the panel must show as one.
    /// Reporting it as an empty working tree is the false-clean shape this
    /// whole module exists to refuse.
    #[cfg(unix)]
    #[test]
    fn a_listing_git_cannot_produce_is_unavailable_never_empty() {
        use std::os::unix::fs::PermissionsExt;
        let (_root, repo) = repository(&[("a.txt", OLD)]);
        track(&repo, "base");
        let index = repo.join(".git/index");
        std::fs::set_permissions(&index, std::fs::Permissions::from_mode(0o000)).unwrap();
        let reason = enumerate(&repo, &AtomicBool::new(false)).err();
        let view = scan(&repo);
        std::fs::set_permissions(&index, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(reason, Some(ActivityReason::ReadFailed));
        assert_eq!(view.state, ActivityState::Unavailable);
        assert_eq!(view.reason, Some(ActivityReason::ReadFailed));
        assert_eq!(view.latest_modified_at, None);
        assert_eq!(view.display_name, None);
    }

    #[test]
    fn a_bare_repository_has_nothing_in_a_working_tree() {
        let root = tempfile::tempdir().unwrap();
        let bare = root.path().join("bare.git");
        std::fs::create_dir(&bare).unwrap();
        repo::git_with(&bare, &[], &["init", "-q", "--bare"]);
        let view = scan(&bare);
        assert_eq!(view.state, ActivityState::Empty);
        assert_eq!(view.latest_modified_at, None);
    }

    /// The cost claim the incremental update exists to keep: a candidate the
    /// index already holds is one `lstat` and one comparison. A file saved again
    /// and again is the ordinary shape of that — each save is later than the one
    /// before, so the maximum only ever rises or stays put, whether the writer is
    /// on the newest file in the tree or on some other one.
    #[test]
    fn a_re_written_candidate_costs_neither() {
        let (_root, repo) = repository(&[("quiet.txt", OLD), ("busy.txt", NEWER)]);
        track(&repo, "base");
        let mut rounds = Rounds::new(&repo);
        rounds.first();
        assert_eq!(
            (rounds.tracker.enumerations, rounds.tracker.rebuilds),
            (1, 0)
        );

        let busy = repo.join("busy.txt");
        let quiet = repo.join("quiet.txt");
        for step in 0..20 {
            stamp(&busy, NEWER + step);
            assert_eq!(rounds.saved(&busy).state, ActivityState::Ready);
            stamp(&quiet, OLD + step);
            assert_eq!(rounds.saved(&quiet).state, ActivityState::Ready);
        }
        assert_eq!(
            (rounds.tracker.enumerations, rounds.tracker.rebuilds),
            (1, 0),
            "forty saves of known files cost a Git read or a walk over the table"
        );
        assert_eq!(rounds.tracker.index.latest(), Some(NEWER + 19));
    }

    /// The one case that does cost a walk: the file holding the answer left.
    /// It is still not a case that costs Git, which is the whole trade.
    #[test]
    fn losing_the_holder_costs_one_walk_not_one_enumeration() {
        let (_root, repo) = repository(&[("older.txt", OLD), ("holder.txt", NEWER)]);
        track(&repo, "base");
        let mut rounds = Rounds::new(&repo);
        rounds.first();
        std::fs::remove_file(repo.join("holder.txt")).unwrap();
        let view = rounds.named(&[], &[repo.join("holder.txt")]);
        assert_eq!(view.state, ActivityState::Ready);
        assert_eq!(view.latest_modified_at, Some(OLD));
        assert_eq!(view.display_name.as_deref(), Some("older.txt"));
        assert_eq!(
            (rounds.tracker.enumerations, rounds.tracker.rebuilds),
            (1, 1),
            "the maximum was either re-derived from Git or left at the deleted file"
        );
    }

    /// A deleted directory is named by its own path and by nothing below it, so
    /// eviction has to take the whole subtree — and only that subtree, since a
    /// sibling whose name merely starts with the same letters is not below it.
    #[test]
    fn a_removed_directory_takes_its_subtree_out_of_the_age() {
        let (_root, repo) = repository(&[
            ("dir/holder.txt", NEWER),
            ("dir-2/sibling.txt", OLD),
            ("rest.txt", OLD),
        ]);
        track(&repo, "base");
        let mut rounds = Rounds::new(&repo);
        rounds.first();
        std::fs::remove_dir_all(repo.join("dir")).unwrap();
        let view = rounds.named(&[], &[repo.join("dir")]);
        assert_eq!(view.latest_modified_at, Some(OLD));
        assert_eq!(
            rounds.tracker.index.entries.len(),
            2,
            "either the subtree survived or the sibling was taken with it"
        );
        assert_eq!(rounds.tracker.rebuilds, 1);
    }

    /// A name the enumeration never produced cannot be classified by looking at
    /// it, so it costs one Git read — and exactly one, because that read rebuilds
    /// the index every later round amends.
    #[test]
    fn a_new_file_costs_one_enumeration_then_is_amendable() {
        let (_root, repo) = repository(&[("a.txt", OLD)]);
        track(&repo, "base");
        let mut rounds = Rounds::new(&repo);
        rounds.first();
        let fresh = repo.join("fresh.txt");
        std::fs::write(&fresh, b"body\n").unwrap();
        stamp(&fresh, FUTURE);

        let view = rounds.saved(&fresh);
        assert_eq!(view.state, ActivityState::Ready);
        assert_eq!(view.latest_modified_at, Some(FUTURE));
        assert_eq!(rounds.tracker.enumerations, 2, "a new name needs Git");

        stamp(&fresh, NEWER);
        let second = rounds.saved(&fresh);
        assert_eq!(second.latest_modified_at, Some(NEWER));
        assert_eq!(
            rounds.tracker.enumerations, 2,
            "a name the index holds asked Git again"
        );
    }

    /// The other way a number goes down without a file leaving: a checkout, a
    /// revert or a tool that preserves timestamps can write an *older* mtime onto
    /// the very file that holds the maximum. One comparison cannot answer that, so
    /// `note` says so and the round re-derives — a walk, not Git.
    #[test]
    fn an_older_mtime_on_the_holder_does_not_leave_the_age_behind() {
        let (_root, repo) = repository(&[("a.txt", OLD), ("holder.txt", FUTURE)]);
        track(&repo, "base");
        let mut rounds = Rounds::new(&repo);
        rounds.first();
        let holder = repo.join("holder.txt");
        stamp(&holder, NEWER);
        let view = rounds.named(&[holder], &[]);
        assert_eq!(
            view.latest_modified_at,
            Some(NEWER),
            "the holder moved backwards and the age stayed at the future"
        );
        assert_eq!(
            (rounds.tracker.enumerations, rounds.tracker.rebuilds),
            (1, 1),
            "a backwards mtime was answered with Git rather than with the walk it costs"
        );
    }

    /// The failure this rule exists to prevent: the watcher names a file Git
    /// excludes, and measuring it would put a build artifact on the age line.
    #[test]
    fn a_new_file_git_excludes_never_reaches_the_age_line() {
        let (_root, repo) = repository(&[(".gitignore", OLD), ("a.txt", OLD)]);
        std::fs::write(repo.join(".gitignore"), b"build/\n").unwrap();
        stamp(&repo.join(".gitignore"), OLD);
        std::fs::create_dir_all(repo.join("build")).unwrap();
        let artifact = repo.join("build/artifact.o");
        std::fs::write(&artifact, b"body\n").unwrap();
        stamp(&artifact, FUTURE);
        track(&repo, "base");

        let mut rounds = Rounds::new(&repo);
        rounds.first();
        let view = rounds.saved(&artifact);
        assert_eq!(
            view.latest_modified_at,
            Some(OLD),
            "an excluded file moved the age line"
        );
        assert!(
            !rounds
                .tracker
                .index
                .contains(OsStr::new("build/artifact.o")),
            "the excluded file entered the index even though the age ignored it"
        );
        assert_eq!(rounds.tracker.enumerations, 2);
    }

    /// Git writes its own bookkeeping constantly: an index refresh, a new
    /// object, a ref move. Those events justify a fresh snapshot and nothing
    /// else — counting them would make a commit look like an edit.
    #[test]
    fn an_event_inside_the_git_directory_moves_nothing() {
        let (_root, repo) = repository(&[("a.txt", OLD)]);
        track(&repo, "base");
        let mut rounds = Rounds::new(&repo);
        rounds.first();
        let head = repo.join(".git/HEAD");
        let index = repo.join(".git/index");
        let view = rounds.named(&[head, index], &[]);
        assert_eq!(view.latest_modified_at, Some(OLD));
        assert_eq!(
            (rounds.tracker.enumerations, rounds.tracker.rebuilds),
            (1, 0),
            "Git's own metadata cost a Git read, or evicted a candidate"
        );
    }

    /// A rule file is not an ordinary candidate: it decides which names the
    /// enumeration produces, so rewriting it re-measures the repository even
    /// though the file itself is already in the index and perfectly measurable.
    #[test]
    fn a_re_written_gitignore_re_measures_the_repository() {
        let (_root, repo) = repository(&[("a.txt", OLD), (".gitignore", OLD)]);
        std::fs::write(repo.join(".gitignore"), b"build/\n").unwrap();
        stamp(&repo.join(".gitignore"), OLD);
        std::fs::create_dir_all(repo.join("build")).unwrap();
        let artifact = repo.join("build/artifact.o");
        std::fs::write(&artifact, b"body\n").unwrap();
        stamp(&artifact, FUTURE);
        track(&repo, "base");

        let mut rounds = Rounds::new(&repo);
        assert_eq!(rounds.first().latest_modified_at, Some(OLD));
        // Dropping the rule is an event on the rule file, never on the artifact.
        std::fs::write(repo.join(".gitignore"), b"\n").unwrap();
        stamp(&repo.join(".gitignore"), OLD);
        let after = rounds.named(&[repo.join(".gitignore")], &[]);
        assert_eq!(
            after.latest_modified_at,
            Some(FUTURE),
            "un-ignoring a file left it out of the age"
        );
        assert_eq!(after.display_name.as_deref(), Some("build/artifact.o"));
        assert_eq!(rounds.tracker.enumerations, 2);
    }

    /// The window that has given up its detail must never be answered from the
    /// index: the bounded set drops names, and a guess about which files are
    /// left is how an overflowed watcher comes to look like an idle repository.
    #[test]
    fn a_window_without_detail_is_not_answered_from_the_index() {
        let (_root, repo) = repository(&[("a.txt", OLD)]);
        track(&repo, "base");
        let mut rounds = Rounds::new(&repo);
        rounds.first();
        let fresh = repo.join("fresh.txt");
        std::fs::write(&fresh, b"body\n").unwrap();
        stamp(&fresh, FUTURE);
        assert_eq!(rounds.blind().latest_modified_at, Some(FUTURE));
        assert_eq!(rounds.tracker.enumerations, 2);
    }

    /// A linked worktree can hand over an event whose path is not under the
    /// directory being measured. Stripping the prefix anyway would produce a key
    /// that is not the file's candidate name, so the round asks Git instead.
    #[test]
    fn a_path_outside_the_work_root_is_not_guessed_at() {
        let (root, repo) = repository(&[("a.txt", OLD)]);
        track(&repo, "base");
        let mut rounds = Rounds::new(&repo);
        rounds.first();
        let outside = root.path().join("sibling.txt");
        std::fs::write(&outside, b"body\n").unwrap();
        let view = rounds.named(&[outside], &[]);
        assert_eq!(
            view.latest_modified_at,
            Some(OLD),
            "a file outside the repository joined its age line"
        );
        assert_eq!(rounds.tracker.enumerations, 2);
    }

    /// The one ignore source no watcher can report, because it lives outside the
    /// repository: Git reads it afresh on every enumeration, so guit compares
    /// its stamp and re-measures when it moves. The window here names a file the
    /// index already holds, which means the enumeration below can only have come
    /// from that comparison.
    #[test]
    fn a_change_to_the_external_ignore_source_re_measures_the_repository() {
        let (root, repo) = repository(&[("a.txt", OLD)]);
        let global = root.path().join("global-ignore");
        std::fs::write(&global, b"late.txt\n").unwrap();
        repo::git_with(
            &repo,
            &[],
            &["config", "core.excludesFile", &global.to_string_lossy()],
        );
        let late = repo.join("late.txt");
        std::fs::write(&late, b"body\n").unwrap();
        stamp(&late, FUTURE);

        let mut rounds = Rounds::new(&repo);
        assert_eq!(
            rounds.first().latest_modified_at,
            Some(OLD),
            "the external rule never reached the enumeration"
        );
        std::fs::write(&global, b"").unwrap();
        let second = rounds.named(&[repo.join("a.txt")], &[]);
        assert_eq!(
            second.latest_modified_at,
            Some(FUTURE),
            "a rule change outside the repository went unnoticed"
        );
        assert_eq!(rounds.tracker.enumerations, 2);
    }

    /// The other direction for the source outside the repository, and the one
    /// that must not be read as a failure: it is deleted, so no outside rules
    /// apply any more. The candidate set still has to be re-measured — a file the
    /// old rules hid is now visible — but the answer is a whole one.
    #[test]
    fn a_deleted_external_ignore_source_is_not_a_failure() {
        let (root, repo) = repository(&[("a.txt", OLD)]);
        let global = root.path().join("global-ignore");
        std::fs::write(&global, b"late.txt\n").unwrap();
        repo::git_with(
            &repo,
            &[],
            &["config", "core.excludesFile", &global.to_string_lossy()],
        );
        let late = repo.join("late.txt");
        std::fs::write(&late, b"body\n").unwrap();
        stamp(&late, FUTURE);

        let mut rounds = Rounds::new(&repo);
        assert_eq!(rounds.first().latest_modified_at, Some(OLD));
        std::fs::remove_file(&global).unwrap();
        let second = rounds.saved(repo.join("a.txt").as_path());
        assert_eq!(
            second.state,
            ActivityState::Ready,
            "an outside source that stopped existing is not a read failure"
        );
        assert_eq!(second.reason, None);
        assert_eq!(
            second.latest_modified_at,
            Some(FUTURE),
            "the rules that hid the file outlived the file holding them"
        );
        assert_eq!(rounds.tracker.enumerations, 2);
    }

    /// The outside source exists but cannot be opened, so the candidate set was
    /// built with rules this panel cannot see: the number still says what it
    /// measured, and `partial` is what says it may not be all of it.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_external_ignore_source_reports_partial() {
        use std::os::unix::fs::PermissionsExt;
        let (root, repo) = repository(&[("a.txt", OLD)]);
        let held = root.path().join("private");
        std::fs::create_dir(&held).unwrap();
        let global = held.join("ignore");
        std::fs::write(&global, b"").unwrap();
        repo::git_with(
            &repo,
            &[],
            &["config", "core.excludesFile", &global.to_string_lossy()],
        );
        std::fs::set_permissions(&held, std::fs::Permissions::from_mode(0o000)).unwrap();
        let view = scan(&repo);
        std::fs::set_permissions(&held, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(view.state, ActivityState::Partial);
        assert_eq!(view.reason, Some(ActivityReason::UnreadablePaths));
        assert!(
            view.latest_modified_at.is_some(),
            "a partial answer still reports what it read"
        );
    }

    /// The cached maximum is what makes an update a comparison instead of a
    /// search, so the property it rests on is asserted directly: a long run of
    /// smaller values leaves the answer exactly where it was. `note` does not
    /// re-derive the maximum on its own — it reports the one case it cannot
    /// answer, the holder moving backwards — and the two rounds that pay for it
    /// are tested above, with the eviction path, as counted walks.
    #[test]
    fn a_steady_writer_does_not_move_the_maximum() {
        let mut index = MtimeIndex::default();
        for step in 0..1_000 {
            index.note(OsString::from(format!("f{step:04}.txt")), NEWER + step);
        }
        assert_eq!(index.latest(), Some(NEWER + 999));
        assert_eq!(index.latest_path(), Some(OsStr::new("f0999.txt")));
        for step in 0..1_000 {
            index.note(OsString::from(format!("g{step:04}.txt")), OLD + step);
        }
        assert_eq!(index.latest(), Some(NEWER + 999));
        assert_eq!(index.entries.len(), 2_000);
    }

    /// Two files touched in the same millisecond is the normal case, not the
    /// exception, and a tie must not be decided by the order Git's listing
    /// happened to come back in.
    #[test]
    fn an_equal_timestamp_is_decided_by_the_path_not_by_arrival_order() {
        let mut forward = MtimeIndex::default();
        let mut reverse = MtimeIndex::default();
        for (index, order) in [(&mut forward, 0), (&mut reverse, 1)] {
            let names = ["a.txt", "b.txt"];
            for name in names.iter().skip(order).chain(names.iter().take(order)) {
                index.note(OsString::from(*name), OLD);
            }
        }
        assert_eq!(forward.latest(), reverse.latest());
        assert_eq!(
            forward.latest_path(),
            reverse.latest_path(),
            "the displayed file changed with the order of the listing"
        );
    }

    #[test]
    fn a_failed_round_claims_no_age_and_no_session() {
        let (_root, repo) = repository(&[("a.txt", OLD)]);
        track(&repo, "base");
        let identity = repo::detect(&repo).unwrap();
        let cancelled = AtomicBool::new(false);
        let mut tracker = ActivityTracker::default();
        tracker.apply(&Window::default(), &identity, 1, &cancelled);
        let view = tracker.unavailable(ActivityReason::RefreshFailed);
        assert_eq!(view.state, ActivityState::Unavailable);
        assert_eq!(view.session_id, None);
        assert_eq!(view.latest_modified_at, None);
        assert_eq!(view.display_name, None);
        assert_eq!(view.reason, Some(ActivityReason::RefreshFailed));
        assert_eq!(view.generation, 2, "a failed round is still a new answer");
        assert!(
            tracker.index.is_empty(),
            "a failed round must not keep the previous number alive"
        );
    }

    #[test]
    fn each_round_is_a_new_generation_of_the_same_session() {
        let (_root, repo) = repository(&[("a.txt", OLD)]);
        track(&repo, "base");
        let identity = repo::detect(&repo).unwrap();
        let cancelled = AtomicBool::new(false);
        let mut tracker = ActivityTracker::default();
        let first = tracker.apply(&Window::default(), &identity, 7, &cancelled);
        let second = tracker.apply(&Window::default(), &identity, 7, &cancelled);
        assert_eq!((first.generation, second.generation), (1, 2));
        assert_eq!(second.session_id, Some(7));
        assert_eq!(first.latest_modified_at, second.latest_modified_at);
    }

    /// The payload is read by name on the other side of a stringly-typed
    /// channel, so its keys are asserted here as well as across the frontend
    /// fixture: renaming one field must fail somewhere on purpose.
    #[test]
    fn the_payload_is_camel_case_and_its_states_are_lowercase() {
        let view = ActivityView {
            session_id: Some(3),
            generation: 4,
            state: ActivityState::Ready,
            latest_modified_at: Some(OLD),
            observed_at: NEWER,
            display_name: Some("a.txt".to_owned()),
            reason: None,
        };
        let json = serde_json::to_value(&view).unwrap();
        for key in [
            "sessionId",
            "generation",
            "state",
            "latestModifiedAt",
            "observedAt",
            "displayName",
            "reason",
        ] {
            assert!(
                json.as_object().unwrap().contains_key(key),
                "the activity payload lost `{key}`"
            );
        }
        assert_eq!(json["state"], "ready");
        assert_eq!(json["reason"], serde_json::Value::Null);
        let cleared =
            serde_json::to_value(ActivityView::cleared(ActivityReason::SessionClosed)).unwrap();
        assert_eq!(cleared["state"], "unavailable");
        assert_eq!(cleared["reason"], "sessionClosed");
        assert_eq!(cleared["sessionId"], serde_json::Value::Null);
        for (value, name) in [
            (ActivityState::Empty, "empty"),
            (ActivityState::Partial, "partial"),
            (ActivityState::Unavailable, "unavailable"),
        ] {
            assert_eq!(serde_json::to_value(value).unwrap(), name);
        }
    }

    /// Nothing in this module may reach Git over the network or write to it, so
    /// the enumeration has to run with the same controls every other read uses.
    #[test]
    fn the_enumeration_is_a_local_read_that_leaves_no_lock_behind() {
        let (_root, repo) = repository(&[("a.txt", OLD)]);
        track(&repo, "base");
        let lock = repo.join(".git/index.lock");
        let cancelled = AtomicBool::new(false);
        enumerate(&repo, &cancelled).unwrap();
        assert!(!lock.exists(), "the enumeration took the index lock");
    }
}
