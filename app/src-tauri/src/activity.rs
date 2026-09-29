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
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::repo::{self, RepoIdentity};
use crate::runner;

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
    pub fn note(&mut self, path: OsString, mtime: i64) {
        let becomes_newest = match &self.newest {
            None => true,
            Some((best_path, best)) => (mtime, path.as_os_str()) >= (*best, best_path.as_os_str()),
        };
        if becomes_newest {
            self.newest = Some((path.clone(), mtime));
        }
        self.entries.insert(path, mtime);
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
}

/// The refresh loop's own copy of the index: one owner, no lock, born with the
/// session and dropped with it.
#[derive(Debug, Default)]
pub struct ActivityTracker {
    index: MtimeIndex,
    generation: u64,
}

impl ActivityTracker {
    /// Re-enumerate the repository and re-measure it. Everything the read can
    /// mean — a listing that failed, a listing that was too long, a directory
    /// Git could not open, a file that could not be measured — comes back as a
    /// state rather than an error, because "we cannot tell" is the answer the
    /// panel has to be able to show.
    pub fn rescan(
        &mut self,
        identity: &RepoIdentity,
        session_id: u64,
        cancelled: &AtomicBool,
    ) -> ActivityView {
        let started = Instant::now();
        self.generation += 1;
        let view = self.rescan_inner(identity, session_id, cancelled);
        crate::perf::mark("activity.rescan", started.elapsed());
        view
    }

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
            Ok(listing) => listing,
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
                    Ok(mtime) => self.index.note(key, epoch_millis(mtime)),
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
        let partial = unreadable || listing.warned;
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

    fn scan(repo: &Path) -> ActivityView {
        let identity = repo::detect(repo).expect("test repository");
        ActivityTracker::default().rescan(&identity, 1, &AtomicBool::new(false))
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
        let identity = repo::detect(&bare).expect("bare repository");
        let view = ActivityTracker::default().rescan(&identity, 1, &AtomicBool::new(false));
        assert_eq!(view.state, ActivityState::Empty);
        assert_eq!(view.latest_modified_at, None);
    }

    /// The cached maximum is what makes an update a comparison instead of a
    /// search, so the property it rests on is asserted directly: a long run of
    /// smaller values leaves the answer exactly where it was. Note does not
    /// re-derive the maximum when the entry that *holds* it is rewritten, and
    /// that is sound only while nothing forgets — the losing-holder path is
    /// what the incremental update has to add, together with a count of how
    /// often it pays for a walk.
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
        tracker.rescan(&identity, 1, &cancelled);
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
        let first = tracker.rescan(&identity, 7, &cancelled);
        let second = tracker.rescan(&identity, 7, &cancelled);
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
