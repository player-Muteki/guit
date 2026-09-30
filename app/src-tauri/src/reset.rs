//! Reset: three modes at two risk levels. Soft and mixed moves
//! HEAD (and the index) but never touches file contents, so they ride the
//! ordinary write queue. Both modes take their target the same way: the text
//! is refused by shape unless it could be a commit id, and what is acted on is
//! the full commit id Git resolves it to — a branch name, a tag name and every
//! revspec are rejected before Git is asked, because Git would accept them.
//! `--hard` additionally overwrites the working copy and drops
//! commits; it has its own command that only consumes a single-use
//! preview ticket, and the ticket's whole promise is re-checked at
//! confirm time — the tracked-dirty file set, HEAD and the target commit.
//! Any drift refuses the operation before Git is touched; the hard entry
//! is never a default button.

use crate::probe::ProbeError;
use crate::status::StatusEntry;
use crate::write::{self, OperationKind, OperationResult, Outcome, PreviewResult, WriteState};
use crate::{branches, history, model, sequencer, session};
use serde::Deserialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// The wire-level mode of a plain reset. `hard` is deliberately not
/// expressible here: it exists only as the ticketed `reset_hard`
/// command, so no serialized request can reach it by accident.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModeArg {
    Soft,
    Mixed,
}

impl ModeArg {
    fn flag(self) -> &'static str {
        match self {
            ModeArg::Soft => "--soft",
            ModeArg::Mixed => "--mixed",
        }
    }

    fn label(self) -> &'static str {
        match self {
            ModeArg::Soft => "soft",
            ModeArg::Mixed => "mixed",
        }
    }
}

fn read_git(work_root: &Path, args: &[&str]) -> Option<String> {
    let output = branches::run_git(work_root, args, &AtomicBool::new(false)).ok()?;
    if !output.status.success() || output.truncated {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Resolve a target (or HEAD) to the full commit id it names.
fn resolve_commit(work_root: &Path, spec: &str) -> Option<String> {
    read_git(
        work_root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{spec}^{{commit}}"),
        ],
    )
    .filter(|oid| history::valid_oid(oid))
}

/// The shortest abbreviation Git still reads, measured rather than configured:
/// `core.abbrev` sets the width Git *writes* out, and the same four hex
/// resolved in a store of 124 objects and in one of 40,083 alike. Below four,
/// Git reports no candidates at all — not "nothing bears this prefix" but "too
/// short to look" — so the floor is guit's own line to draw.
const MIN_TARGET_LEN: usize = 4;

/// The widest object id any supported format writes.
const MAX_TARGET_LEN: usize = 64;

/// How many candidates the triage asks about one by one. Past this the answer
/// stays "not exactly one commit", which is all a person can act on, and the
/// count stops being worth that many short reads.
const TRIAGE_CANDIDATE_LIMIT: usize = 16;

/// Whether the typed text could be a commit id at all, decided before Git is
/// asked anything. Git resolves `main`, `v1`, `HEAD~1`, `@{0}` and a working
/// file path happily, so "a reset goes to a commit id" is a rule guit enforces
/// and Git never will. Upper case passes because Git reads an upper case id as
/// the same id; what reaches argv is never the typed string but the id Git
/// answers with, which is lowercase and full-width by construction.
#[derive(Debug, PartialEq)]
enum Shape {
    /// Hexadecimal, within the lengths an id can have.
    Hex(String),
    /// Nothing left once the surrounding spaces are dropped.
    Empty,
    /// Not hexadecimal: a name, a revspec, a path, an option-looking string.
    Noise,
    /// Hexadecimal, but shorter than Git reads.
    TooShort,
    /// Hexadecimal, but longer than any format writes.
    TooLong,
}

fn shape_of(target: &str) -> Shape {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Shape::Empty;
    }
    if !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Shape::Noise;
    }
    match trimmed.len() {
        0..MIN_TARGET_LEN => Shape::TooShort,
        MIN_TARGET_LEN..=MAX_TARGET_LEN => Shape::Hex(trimmed.to_ascii_lowercase()),
        _ => Shape::TooLong,
    }
}

/// What asking Git for one commit answered. The three answers are not two: a
/// process that could not be asked, a process that answered no, and a commit.
/// Only the middle one is a fact about the repository, and the first must never
/// be reported as the second — a read failure is not an absent commit.
enum Peel {
    Commit(String),
    No,
    Unaskable,
}

/// `rev-parse --verify --quiet <spec>^{commit}`: Git's own answer to "does this
/// name exactly one commit", including through a tag object, and including for
/// an abbreviation that names a commit alongside a blob.
fn peel_commit(work_root: &Path, spec: &str) -> Peel {
    let output = match branches::run_git(
        work_root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{spec}^{{commit}}"),
        ],
        &AtomicBool::new(false),
    ) {
        Ok(output) => output,
        Err(_) => return Peel::Unaskable,
    };
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if output.status.success() {
        return if !output.truncated && history::valid_oid(&text) {
            Peel::Commit(text)
        } else {
            Peel::Unaskable
        };
    }
    // `--verify --quiet` says "not exactly one commit" with 1 and nothing else.
    // Any other code is Git failing to read the repository, which is not an
    // answer about the target.
    if output.status.code() == Some(1) && !output.truncated {
        Peel::No
    } else {
        Peel::Unaskable
    }
}

/// Every object whose id starts with these characters, of any type: a listing
/// Git exits `0` for whether or not the prefix means anything, printing one
/// full id per line and nothing else. It is the only way to tell "no commit has
/// this id" from "this id is not a commit" from "two commits have it", all of
/// which peel answers with the same rc.
fn candidate_oids(work_root: &Path, hex: &str) -> Result<Vec<String>, ProbeError> {
    let output = branches::run_git(
        work_root,
        &["rev-parse", &format!("--disambiguate={hex}")],
        &AtomicBool::new(false),
    )?;
    if !output.status.success() || output.truncated {
        return Err(ProbeError::new(
            "reset_target_unreadable",
            "Git would not list the objects that bear that id; nothing was changed.",
        ));
    }
    let mut found = Vec::new();
    for line in output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let name = String::from_utf8_lossy(line).trim().to_owned();
        // A listing that is not full lowercase ids is not the listing this was
        // written for, and guessing from it would be a rule of ours, not Git's.
        if !history::valid_oid(&name) {
            return Err(ProbeError::new(
                "reset_target_unreadable",
                "Git listed an object id it does not normally write; nothing was changed.",
            ));
        }
        found.push(name);
    }
    Ok(found)
}

/// Why a shape-correct id is still not a place to reset to, in Git's own
/// answers rather than in a rule invented here.
enum Absent {
    /// Nothing in this repository bears that id.
    Nothing,
    /// Something bears it, and it is not a commit.
    NotCommit,
    /// Several commits bear it.
    Ambiguous(usize),
    /// More objects bear it than the triage will ask about one by one. After a
    /// failed peel the one fact left is that this is not exactly one commit, and
    /// that is what gets said — without a count it did not earn.
    Crowded,
}

/// Triage of a failed peel: how many commits this id names, asked one candidate
/// at a time because `rev-parse` has no type filter of its own (`--type` comes
/// back as an argument, measured) and the batched type query reads stdin, which
/// the process seam closes before anything is written.
fn why_absent(work_root: &Path, hex: &str) -> Result<Absent, ProbeError> {
    let candidates = candidate_oids(work_root, hex)?;
    if candidates.is_empty() {
        return Ok(Absent::Nothing);
    }
    if candidates.len() > TRIAGE_CANDIDATE_LIMIT {
        return Ok(Absent::Crowded);
    }
    let mut commits = 0;
    for candidate in candidates.iter() {
        match peel_commit(work_root, candidate) {
            Peel::Commit(_) => commits += 1,
            Peel::No => {}
            Peel::Unaskable => {
                return Err(ProbeError::new(
                    "reset_target_unreadable",
                    "Git could not be asked about every object that bears that id; nothing was changed.",
                ))
            }
        }
    }
    match commits {
        0 => Ok(Absent::NotCommit),
        // One commit among the candidates is not a possible answer: peel names
        // exactly one commit and succeeds. Getting it means the two reads
        // disagree, which is a read failure, not a fact about the id.
        1 => Err(ProbeError::new(
            "reset_target_unreadable",
            "Git's two answers about that commit id did not fit together; nothing was changed.",
        )),
        count => Ok(Absent::Ambiguous(count)),
    }
}

/// The target a reset will actually use: the full commit id Git itself names,
/// or a refusal that says which of the three ways "no" this is. Everything
/// downstream — argv, the ticket, the recheck at confirm time — consumes only
/// what this returns, so a typed string can never reach a Git command line.
pub(crate) fn resolve_target(work_root: &Path, target: &str) -> Result<String, ProbeError> {
    let hex = match shape_of(target) {
        Shape::Hex(hex) => hex,
        Shape::Empty => {
            return Err(ProbeError::new(
                "reset_target_shape",
                "A reset needs a commit to go to.",
            ))
        }
        Shape::Noise => {
            return Err(ProbeError::new(
                "reset_target_shape",
                "A reset target is written as a commit id, in hexadecimal — not as a branch name or a revision like HEAD~1.",
            ))
        }
        Shape::TooShort => {
            return Err(ProbeError::new(
                "reset_target_shape",
                "That is shorter than any commit id: at least four hexadecimal characters are needed.",
            ))
        }
        Shape::TooLong => {
            return Err(ProbeError::new(
                "reset_target_shape",
                "That is longer than a commit id can be.",
            ))
        }
    };
    match peel_commit(work_root, &hex) {
        Peel::Commit(oid) => return Ok(oid),
        Peel::Unaskable => {
            return Err(ProbeError::new(
                "reset_target_unreadable",
                "Git could not be asked about that commit id; nothing was changed.",
            ))
        }
        Peel::No => {}
    }
    match why_absent(work_root, &hex)? {
        Absent::Nothing => Err(ProbeError::new(
            "reset_target_absent",
            "No object in this repository has that commit id.",
        )),
        Absent::NotCommit => Err(ProbeError::new(
            "reset_target_not_commit",
            "That commit id names something that is not a commit.",
        )),
        Absent::Ambiguous(count) => Err(ProbeError::new(
            "reset_target_ambiguous",
            format!(
                "That abbreviation names {count} commits; give more of the id so one is meant."
            ),
        )),
        Absent::Crowded => Err(ProbeError::new(
            "reset_target_ambiguous",
            "That abbreviation names many objects and not exactly one commit; give more of the id.",
        )),
    }
}

/// Files a hard reset would overwrite: every tracked change (staged or
/// unstaged) plus conflict entries; untracked files survive a hard reset
/// untouched, so they are neither listed nor re-checked.
fn tracked_dirty_set(sessions: &session::SessionState) -> Result<Vec<Vec<u8>>, ProbeError> {
    let entries = write::status_index(sessions)?;
    Ok(entries
        .iter()
        .filter(|(_, entry)| match entry {
            StatusEntry::Tracked(e) => e.index_status != '.' || e.worktree_status != '.',
            StatusEntry::Rename(e) => {
                e.tracked.index_status != '.' || e.tracked.worktree_status != '.'
            }
            StatusEntry::Unmerged(_) => true,
            StatusEntry::Untracked { .. } => false,
        })
        .map(|(raw, _)| raw.clone())
        .collect())
}

/// The shared refusal path: everything rejected happens before Git runs,
/// with the actual state re-read and attached.
pub(crate) fn reset(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    mode: ModeArg,
    target: &str,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_reset(state, sessions, snapshot_version, mode, target);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_reset(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    mode: ModeArg,
    target: &str,
) -> Result<OperationResult, ProbeError> {
    let kind = OperationKind::Reset;
    let (work_root, unborn) = match sessions.commit_context(snapshot_version) {
        Err(error) => return write::plain(sessions, kind, Outcome::Rejected, &error.message),
        Ok(context) => context,
    };
    let in_progress = sequencer::in_progress_message(sessions)?;
    if unborn {
        return write::plain(
            sessions,
            kind,
            Outcome::Rejected,
            "Cannot reset before the first commit.",
        );
    }
    if let Some(refusal) = in_progress {
        return write::plain(sessions, kind, Outcome::Rejected, &refusal);
    }
    if state.cancel_flag().load(Ordering::SeqCst) {
        return write::plain(
            sessions,
            kind,
            Outcome::Cancelled,
            "Cancelled before Git ran.",
        );
    }
    let target_oid = match resolve_target(&work_root, target) {
        Ok(oid) => oid,
        Err(refusal) => {
            return write::plain(sessions, kind, Outcome::Rejected, &refusal.message);
        }
    };
    let args = ["reset", mode.flag(), target_oid.as_str()];
    write::run_and_report(
        sessions,
        kind,
        sequencer::run_git(&work_root, false, &args, state),
        write::Wording {
            ok: format!("Reset ({}) to {}.", mode.label(), short(&target_oid)),
            failed: format!("git reset {} reported a failure.", mode.flag()),
            cancelled: "Cancelled while the Git process was running.".to_owned(),
        },
    )
}

/// Short display prefix for a full commit id in confirmation lists.
fn short(oid: &str) -> String {
    oid.chars().take(10).collect()
}

/// How many discarded commit subjects the panel lists before summarising.
const DROPPED_DISPLAY_LIMIT: usize = 20;

pub(crate) fn preview_reset_hard(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    target: &str,
) -> Result<PreviewResult, ProbeError> {
    let (work_root, unborn) = sessions.commit_context(snapshot_version)?;
    if unborn {
        return Err(ProbeError::new(
            "reset_unborn",
            "Cannot reset before the first commit.",
        ));
    }
    if let Some(refusal) = sequencer::in_progress_message(sessions)? {
        return Err(ProbeError::new("reset_in_progress", refusal));
    }
    // Everything the ticket binds and every id the preview lists come from this
    // one resolution, so a hard reset's target is Git's own full commit id and
    // never the string that was typed.
    let target_oid = resolve_target(&work_root, target)?;
    let head_oid = resolve_commit(&work_root, "HEAD")
        .ok_or_else(|| ProbeError::new("reset_head", "HEAD does not name a commit."))?;
    let dirty = tracked_dirty_set(sessions)?;
    // What leaving HEAD where it is would drop, listed from the same
    // fresh read that produced the ids.
    let mut dropped = Vec::new();
    if head_oid != target_oid {
        let listed = read_git(
            &work_root,
            &[
                "rev-list",
                "--max-count",
                &(DROPPED_DISPLAY_LIMIT + 1).to_string(),
                &head_oid,
                &format!("^{target_oid}"),
            ],
        )
        .ok_or_else(|| {
            ProbeError::new(
                "reset_preview_failed",
                "Git could not list the commits a hard reset would discard; the reset was refused.",
            )
        })?;
        let listed = listed.lines().map(str::to_owned).collect::<Vec<_>>();
        if listed.len() > DROPPED_DISPLAY_LIMIT {
            let total = read_git(
                &work_root,
                &["rev-list", "--count", &head_oid, &format!("^{target_oid}")],
            )
            .and_then(|count| count.parse::<usize>().ok())
            .ok_or_else(|| {
                ProbeError::new(
                    "reset_preview_failed",
                    "Git could not count the commits a hard reset would discard; the reset was refused.",
                )
            })?;
            dropped.extend(listed[..DROPPED_DISPLAY_LIMIT].iter().map(|oid| short(oid)));
            dropped.push(format!("… {} commits in total", total));
        } else {
            dropped.extend(listed.iter().map(|oid| short(oid)));
        }
    }
    let nonce = state.stage_reset_hard(work_root, dirty.clone(), target_oid.clone(), head_oid);
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    Ok(PreviewResult {
        nonce,
        candidates: dirty.iter().map(|raw| model::display_name(raw)).collect(),
        dropped,
        snapshot,
        target_oid: Some(target_oid),
    })
}

pub(crate) fn reset_hard(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_reset_hard(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_reset_hard(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    write::confirm(
        state,
        sessions,
        OperationKind::ResetHard,
        nonce,
        write::Refusals {
            expired: "That confirmation has expired; preview the action again.",
            session_changed: "A different repository is open now; preview the reset again.",
            cancelled_before_git: "Cancelled before Git ran.",
        },
        |preview| match preview.bound {
            write::Bound::ResetHard {
                dirty,
                target_oid,
                head_oid,
            } => Some((preview.work_root, (dirty, target_oid, head_oid))),
            _ => None,
        },
        |work_root, (expected_dirty, target_oid, expected_head)| {
            if let Some(refusal) = sequencer::in_progress_message(sessions)? {
                return Ok(Err(refusal));
            }
            // The ticket promised exactly this HEAD, this target and this
            // dirty set; anything else means the preview no longer describes
            // reality.
            let Some(head_now) = resolve_commit(work_root, "HEAD") else {
                return Ok(Err(
                    "HEAD no longer names a commit; preview the reset again.".to_owned(),
                ));
            };
            if head_now != *expected_head {
                return Ok(Err(
                    "The branch moved since the preview; nothing was changed. Preview the reset again."
                        .to_owned(),
                ));
            }
            if resolve_commit(work_root, target_oid).as_deref() != Some(target_oid.as_str()) {
                return Ok(Err(
                    "The target commit is no longer reachable; preview the reset again.".to_owned(),
                ));
            }
            let dirty_now = tracked_dirty_set(sessions)?;
            if dirty_now != *expected_dirty {
                return Ok(Err(
                    "The working copy changed since the preview; nothing was changed. Preview the reset again."
                        .to_owned(),
                ));
            }
            Ok(Ok(()))
        },
        |work_root, (_, target_oid, _)| {
            write::ran_from(
                sequencer::run_git(work_root, false, &["reset", "--hard", target_oid], state),
                write::Wording {
                    ok: format!(
                        "Hard reset to {}. Discarded the working-copy changes listed in the preview.",
                        short(target_oid)
                    ),
                    failed: "git reset --hard reported a failure.".to_owned(),
                    cancelled:
                        "Cancelled while the Git process was running. The reset may have partly applied; the refreshed snapshot shows the actual state."
                            .to_owned(),
                },
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        crate::repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=test@example.invalid",
            ],
            args,
        );
    }

    fn read(dir: &Path, args: &[&str]) -> String {
        let output = branches::run_git(dir, args, &AtomicBool::new(false)).unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// c2 on top of c1; the working copy then carries one unstaged edit
    /// (b.txt), one staged addition (c.txt) and one untracked file (u.txt).
    fn dirty_repo() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        git(dir, &["config", "user.name", "guit test"]);
        git(dir, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("b.txt"), "one\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "first"]);
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        git(dir, &["add", "a.txt"]);
        git(dir, &["commit", "-m", "second"]);
        std::fs::write(dir.join("b.txt"), "b changed\n").unwrap();
        std::fs::write(dir.join("c.txt"), "new\n").unwrap();
        git(dir, &["add", "c.txt"]);
        std::fs::write(dir.join("u.txt"), "untracked\n").unwrap();
        root
    }

    fn state_and_session(dir: &Path) -> (WriteState, session::SessionState, u64) {
        let writes = WriteState::default();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        (writes, sessions, view.version)
    }

    fn group_of(result: &OperationResult, name: &str) -> Option<model::FileGroup> {
        result
            .snapshot
            .as_ref()?
            .files
            .iter()
            .find_map(|file| file.display.ends_with(name).then_some(file.group))
    }

    #[test]
    fn soft_reset_moves_head_and_keeps_index_and_files() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let result = reset(&writes, &sessions, version, ModeArg::Soft, &c1).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), c1);
        // Index untouched: the staged addition stays staged and the index
        // content of a.txt still says "two"; nothing on disk was written.
        assert_eq!(group_of(&result, "c.txt"), Some(model::FileGroup::Staged));
        assert_eq!(read(dir, &["show", ":a.txt"]), "two");
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "b changed\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("u.txt")).unwrap(),
            "untracked\n"
        );
    }

    #[test]
    fn mixed_reset_moves_head_and_index_but_not_files() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let result = reset(&writes, &sessions, version, ModeArg::Mixed, &c1).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), c1);
        // Index back to HEAD: a.txt is an unstaged edit again and the
        // staged c.txt falls out of the index while its file stays on disk.
        assert_eq!(group_of(&result, "a.txt"), Some(model::FileGroup::Worktree));
        assert_eq!(
            group_of(&result, "c.txt"),
            Some(model::FileGroup::Untracked)
        );
        assert_eq!(std::fs::read_to_string(dir.join("c.txt")).unwrap(), "new\n");
    }

    #[test]
    fn hard_reset_lists_targets_and_only_then_applies() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c2 = read(dir, &["rev-parse", "HEAD"]);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        assert_eq!(preview.target_oid.as_deref(), Some(c1.as_str()));
        // The promise: exactly the tracked-dirty files, and the commit
        // left behind. Untracked files survive a hard reset and so must
        // not appear in the list.
        let names = preview.candidates.join("|");
        assert!(
            names.contains("b.txt") && names.contains("c.txt"),
            "{names}"
        );
        assert!(
            !names.contains("u.txt"),
            "untracked files must not be listed"
        );
        assert_eq!(preview.dropped, vec![short(&c2)]);

        let result = reset_hard(&writes, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), c1);
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "one\n");
        assert_eq!(read(dir, &["show", ":a.txt"]), "one");
        // c.txt was staged only, never committed — and a hard reset wipes
        // index-tracked state, so Git deletes the file itself. That is
        // precisely why the ticket lists it, while the purely untracked
        // u.txt was never in danger and must survive.
        assert!(!dir.join("c.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("u.txt")).unwrap(),
            "untracked\n"
        );

        // The ticket is spent: replay is refused without touching Git.
        let replay = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));
        assert_eq!(replay.exit_code, None);
    }

    #[test]
    fn dirty_set_drift_between_preview_and_confirm_is_refused() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let head = read(dir, &["rev-parse", "HEAD"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        // An external edit to a previously clean tracked file changes what
        // the reset would destroy — the preview no longer describes reality.
        std::fs::write(dir.join("a.txt"), "externally edited\n").unwrap();
        let refused = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(refused.message.contains("working copy changed"));
        assert_eq!(refused.exit_code, None, "refusal must not reach git");
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "b changed\n",
            "nothing may be restored on a refusal"
        );
    }

    #[test]
    fn head_drift_between_preview_and_confirm_is_refused() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        // An external commit means the set of dropped commits changed.
        git(dir, &["commit", "--allow-empty", "-m", "external"]);
        let refused = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(refused.message.contains("branch moved"));
        assert_eq!(refused.exit_code, None);
        assert_eq!(read(dir, &["log", "-1", "--format=%s"]), "external");
    }

    #[test]
    fn reset_targets_are_validated_before_git() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let mut version = version;
        // Names, revspecs and shorthands never reach git, in either direction
        // of the mode split. Git resolves every one of them; refusing them is
        // the panel's rule, applied to the shape of the text.
        for bad in [
            "HEAD~1",
            "@{u}",
            "nosuchbranch",
            "main extra",
            "HEAD",
            "main",
            "v1",
            "",
            "   ",
        ] {
            let result = reset(&writes, &sessions, version, ModeArg::Soft, bad).unwrap();
            assert_eq!(result.outcome, Outcome::Rejected, "{bad:?} accepted");
            assert_eq!(result.exit_code, None, "{bad:?} reached git");
            // Each refusal re-read state, so the next attempt needs its version.
            version = result.snapshot.expect("re-read").version;
        }
        // A well-formed but nonexistent commit is caught at hard preview too
        // (soft/mixed leave it to Git's own failure reporting).
        let ghost = "deadbeef".repeat(5);
        let error = preview_reset_hard(&writes, &sessions, version, &ghost).unwrap_err();
        assert_eq!(error.code.as_str(), "reset_target_absent");
        // And a branch name is not a legitimate hard target either: the ticket
        // would bind the commit it points at today and a different one later.
        let error = preview_reset_hard(&writes, &sessions, version, "main").unwrap_err();
        assert_eq!(error.code.as_str(), "reset_target_shape");
    }

    #[test]
    fn a_shape_gate_needs_no_git_to_answer() {
        // The gate is the whole reason a revspec cannot reach a command line,
        // so it is checked without a repository: what passes is hexadecimal of a
        // length an id can have, in either case, and nothing else.
        assert!(matches!(shape_of(""), Shape::Empty));
        assert!(matches!(shape_of(" \t\n "), Shape::Empty));
        for noise in [
            "main",
            "HEAD~1",
            "@{0}",
            "--help",
            "-deadbeef",
            "de adbeef",
            "deadbeeg",
        ] {
            assert!(matches!(shape_of(noise), Shape::Noise), "{noise:?} passed");
        }
        assert!(matches!(shape_of("abc"), Shape::TooShort));
        assert!(matches!(shape_of("abcd"), Shape::Hex(_)));
        assert!(matches!(shape_of(&"a".repeat(64)), Shape::Hex(_)));
        assert!(matches!(shape_of(&"a".repeat(65)), Shape::TooLong));
        // Surrounding spaces are dropped, and the case is normalised into the
        // text that is asked about — never into the text that is acted on.
        assert_eq!(shape_of(" 0F44 "), shape_of("0f44"));
        assert_eq!(shape_of("0F44"), Shape::Hex("0f44".to_owned()));
    }

    #[test]
    fn an_abbreviation_names_the_commit_it_uniquely_names() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        // Four hex is where Git stops resolving, measured: the same four
        // resolved in a store of 124 objects and one of 40,083. This repository
        // holds five objects, so a four-digit prefix names one commit uniquely.
        let abbreviation = &c1[..4];
        let preview = preview_reset_hard(&writes, &sessions, version, abbreviation).unwrap();
        assert_eq!(preview.target_oid.as_deref(), Some(c1.as_str()));
        // What a soft reset acts on is the id Git answered, and what its
        // sentence reports is that id rather than the four characters typed.
        // The preview re-read the repository, so the write takes that snapshot.
        let version = preview.snapshot.version;
        let result = reset(&writes, &sessions, version, ModeArg::Soft, abbreviation).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert!(result.message.contains(&c1[..10]), "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), c1);
    }

    #[test]
    fn an_id_copied_in_upper_case_is_the_same_commit() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1.to_uppercase()).unwrap();
        assert_eq!(preview.target_oid.as_deref(), Some(c1.as_str()));
    }

    #[test]
    fn the_id_of_a_thing_that_is_not_a_commit_is_named_as_one() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        // A blob's full id resolves perfectly well as an object, and a bare id
        // is what Git would accept: only the peel to a commit rules it out, so
        // this is the refusal that has to say "not a commit" and not "missing".
        let blob = read(dir, &["rev-parse", "HEAD:a.txt"]);
        let error = preview_reset_hard(&writes, &sessions, version, &blob).unwrap_err();
        assert_eq!(error.code.as_str(), "reset_target_not_commit");
        assert!(
            !error.message.contains("does not exist"),
            "{}",
            error.message
        );
        // And the same text asked by a soft reset is refused without a run.
        let refused = reset(&writes, &sessions, version, ModeArg::Soft, &blob).unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert_eq!(
            refused.exit_code, None,
            "a refused target must not reach git"
        );
    }

    /// Four hex digits shared by two of the commits written into `dir`, with a
    /// candidate list short enough for the triage to count — or `None` when the
    /// search found no such prefix.
    ///
    /// Ambiguity cannot be waited for: the repository the other tests build has
    /// no two objects sharing four hex, and four is where Git stops resolving.
    /// So the objects are made to collide. A commit is just text, so the
    /// payloads are written by hand and handed to `hash-object -t commit -w`,
    /// which answers with the id of each one; a timestamp per payload is what
    /// makes the ids differ. The birthday arithmetic says a few hundred commits
    /// make a pair likely, so the search goes in batches and stops at the first
    /// prefix two of them share.
    fn colliding_commit_prefix(dir: &Path) -> Option<String> {
        let head = read(dir, &["rev-parse", "HEAD"]);
        let tree = read(dir, &["rev-parse", "HEAD^{tree}"]);
        let payloads = tempfile::tempdir().unwrap();
        for batch in 0..2 {
            let mut paths = Vec::new();
            for index in 0..1500u32 {
                let number = batch * 1500 + index;
                let payload = format!(
                    "tree {tree}\nparent {head}\nauthor probe <probe@example.invalid> {} +0000\n\
                     committer probe <probe@example.invalid> {} +0000\n\nambiguous {number}",
                    1_600_000_000 + number,
                    1_600_000_000 + number,
                );
                let path = payloads.path().join(format!("c{number}"));
                std::fs::write(&path, payload).unwrap();
                paths.push(path);
            }
            let mut argv: Vec<&str> = vec!["hash-object", "-t", "commit", "-w", "--"];
            argv.extend(paths.iter().map(|path| path.to_str().unwrap()));
            let listed = read(dir, &argv);
            for path in &paths {
                std::fs::remove_file(path).ok();
            }
            let ids = listed.lines().collect::<Vec<_>>();
            assert_eq!(
                ids.len(),
                1500,
                "hash-object did not report every commit it was handed"
            );
            // Two commits sharing a prefix is the fact; the listing Git itself
            // reports is what the triage has to stay inside of.
            let mut shared: Vec<&str> = Vec::new();
            for (left, left_id) in ids.iter().enumerate() {
                if ids[left + 1..]
                    .iter()
                    .any(|other| other[..4] == left_id[..4])
                {
                    shared.push(&left_id[..4]);
                }
            }
            for prefix in shared {
                let candidates = read(dir, &["rev-parse", &format!("--disambiguate={prefix}")]);
                if candidates.lines().count() <= TRIAGE_CANDIDATE_LIMIT {
                    return Some(prefix.to_owned());
                }
            }
        }
        None
    }

    #[test]
    fn an_abbreviation_that_names_two_commits_says_so_with_their_count() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let Some(prefix) = colliding_commit_prefix(dir) else {
            panic!(
                "3000 commits written two batches at a time produced no countable colliding prefix"
            );
        };
        // Git's peel answers "not exactly one" for both an absent id and an
        // ambiguous one; the count of commits is what makes these two different
        // sentences, and it comes from asking every candidate separately.
        let error = preview_reset_hard(&writes, &sessions, version, &prefix).unwrap_err();
        assert_eq!(error.code.as_str(), "reset_target_ambiguous");
        let count: String = error
            .message
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let named: usize = count
            .parse()
            .unwrap_or_else(|_| panic!("no count in the refusal: {}", error.message));
        assert!(
            named >= 2,
            "{named} commits is not ambiguous: {}",
            error.message
        );
        let head = read(dir, &["rev-parse", "HEAD"]);
        let refused = reset(&writes, &sessions, version, ModeArg::Soft, &prefix).unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert_eq!(
            refused.exit_code, None,
            "an ambiguous target must not reach git"
        );
        assert_eq!(
            read(dir, &["rev-parse", "HEAD"]),
            head,
            "HEAD must not move"
        );
    }

    #[test]
    fn in_progress_and_stale_versions_refuse_resets() {
        let root = crate::sequencer::tests::diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        // A reset while a merge is conflicted would compound damage; the
        // sequencer exposes the fixture the refusal is checked against.
        let conflicted =
            crate::sequencer::merge_start(&writes, &sessions, version, "side").unwrap();
        let view = conflicted.snapshot.expect("in-flight");
        let refused = reset(&writes, &sessions, view.version, ModeArg::Mixed, "side").unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(refused.message.contains("already in progress"));
        // Stale versions are refused by the session gate itself.
        let fresh = refused.snapshot.expect("re-read").version;
        let stale = reset(&writes, &sessions, fresh + 7, ModeArg::Soft, "side").unwrap();
        assert_eq!(stale.outcome, Outcome::Rejected);
        assert!(stale.message.contains("rejected"));
    }

    /// An unborn HEAD is refused by both entries, and neither refusal is an
    /// `OperationResult`: a hard reset on an empty repository has nothing to
    /// preview, so the preview must fail rather than offer a ticket.
    #[test]
    fn an_unborn_head_is_refused_before_any_target_is_parsed() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        let (writes, sessions, version) = state_and_session(dir);
        let soft = reset(&writes, &sessions, version, ModeArg::Soft, "main").unwrap();
        assert_eq!(soft.outcome, Outcome::Rejected);
        assert!(
            soft.message.contains("before the first commit"),
            "{}",
            soft.message
        );
        // The hard entry reports the same fact as an error code, because the
        // caller has nowhere to show a preview it cannot produce. The refusal
        // above re-read state, so the next call needs the newer version.
        let version = soft.snapshot.expect("re-read").version;
        let error = preview_reset_hard(&writes, &sessions, version, "main").unwrap_err();
        assert_eq!(error.code.as_str(), "reset_unborn");
    }

    /// A cancel that arrives before Git starts is reported as `Cancelled`,
    /// not as a rejection, and — like every other exit — still hands back a
    /// freshly read snapshot. The caller refreshes from it either way.
    #[test]
    fn a_cancel_before_git_starts_never_reaches_git() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let head = read(dir, &["rev-parse", "HEAD"]);
        // `reset` takes the queue slot, and taking the slot clears the cancel
        // flag, so the flag is set inside a held operation — which is also
        // the only order a real cancellation can arrive in.
        writes.begin().unwrap();
        writes.cancel();
        let result = run_reset(&writes, &sessions, version, ModeArg::Soft, &c1).unwrap();
        writes.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert!(
            result.message.contains("before Git ran"),
            "{}",
            result.message
        );
        assert_eq!(result.exit_code, None);
        assert_eq!(
            read(dir, &["rev-parse", "HEAD"]),
            head,
            "HEAD must not move"
        );
        assert!(
            result.snapshot.is_some(),
            "a cancelled reset still re-reads state"
        );
    }

    /// The same cancel, one entry later: the hard reset has already spent its
    /// ticket and re-checked every bound fact, and the cancel flag is the
    /// last gate before `git reset --hard`. The working copy must survive.
    #[test]
    fn a_cancelled_hard_reset_leaves_the_working_copy_alone() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let head = read(dir, &["rev-parse", "HEAD"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        writes.begin().unwrap();
        writes.cancel();
        let result = run_reset_hard(&writes, &sessions, &preview.nonce).unwrap();
        writes.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert!(
            result.message.contains("before Git ran"),
            "{}",
            result.message
        );
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "b changed\n",
            "a cancelled hard reset must not overwrite anything"
        );
        assert!(
            dir.join("c.txt").exists(),
            "a cancelled hard reset deletes nothing"
        );
    }

    /// More than twenty dropped commits must be summarised with a real
    /// count, not silently truncated to the display limit. The `… N commits
    /// in total` line is the only thing telling the user the list is partial.
    #[test]
    fn a_long_dropped_history_is_summarised_with_its_true_count() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        git(dir, &["config", "user.name", "guit test"]);
        git(dir, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "first"]);
        let first = read(dir, &["rev-parse", "HEAD"]);
        for i in 0..25 {
            git(
                dir,
                &["commit", "--allow-empty", "-m", &format!("filler {i}")],
            );
        }
        std::fs::write(dir.join("a.txt"), "dirty\n").unwrap();
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_reset_hard(&writes, &sessions, version, &first).unwrap();
        // Twenty ids plus the summary line.
        assert_eq!(preview.dropped.len(), DROPPED_DISPLAY_LIMIT + 1);
        let summary = preview.dropped.last().unwrap();
        assert_eq!(summary, "… 25 commits in total", "{summary}");
        // Every listed id is a real, short commit id — the panel shows these
        // to the user, so a truncated or padded one would be a lie.
        for oid in &preview.dropped[..DROPPED_DISPLAY_LIMIT] {
            assert_eq!(oid.len(), 10, "{oid}");
            assert!(oid.bytes().all(|b| b.is_ascii_hexdigit()), "{oid}");
        }
        assert_eq!(preview.candidates, vec!["a.txt"]);
    }

    /// Resetting to HEAD drops nothing, so the preview's dropped list is
    /// empty — the panel must not imply that commits are about to be lost.
    #[test]
    fn a_reset_to_head_drops_nothing() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let head = read(dir, &["rev-parse", "HEAD"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &head).unwrap();
        assert!(preview.dropped.is_empty(), "{:?}", preview.dropped);
        assert_eq!(preview.target_oid.as_deref(), Some(head.as_str()));
        let result = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), head);
    }

    /// The ticket is bound to the repository that produced it. Switching to
    /// another open repository and then confirming must be refused even
    /// though the nonce, the target and the dirty set would all still match.
    #[test]
    fn a_ticket_does_not_survive_switching_repositories() {
        let first = dirty_repo();
        let second = dirty_repo();
        let (writes, sessions, version) = state_and_session(first.path());
        let c1 = read(first.path(), &["rev-parse", "HEAD~1"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        // Same shape, same commit ids, same dirty set: only the identity
        // check can tell these two repositories apart, so the ticket binding
        // it to a work root is the only thing standing between a preview of
        // one repository and a reset of another.
        session::open(&sessions, second.path()).unwrap();
        let second_head = read(second.path(), &["rev-parse", "HEAD"]);
        let refused = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(
            refused.message.contains("different repository"),
            "{}",
            refused.message
        );
        // The second repository's working copy is untouched, and it is the
        // *open* one, so a wrong reset here would be the most destructive
        // bug this module could have.
        assert_eq!(read(second.path(), &["rev-parse", "HEAD"]), second_head);
        assert_eq!(
            std::fs::read_to_string(second.path().join("b.txt")).unwrap(),
            "b changed\n",
            "the newly opened repository must be untouched"
        );
        assert_eq!(
            std::fs::read_to_string(first.path().join("b.txt")).unwrap(),
            "b changed\n"
        );
    }

    /// `git reset --hard` failing is a reported outcome, not an error, and
    /// the failure Git reports is the one the user is shown. A stale
    /// `index.lock` is the honest way to make Git itself fail: `git status`
    /// still reads, so the ticket's own re-checks pass and the failure lands
    /// on the write, which is the branch under test. Unlike a permission
    /// change this also fails for a process running as root.
    #[test]
    fn a_failing_hard_reset_is_reported_with_its_own_stderr() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let head = read(dir, &["rev-parse", "HEAD"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        let lock = dir.join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let result = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        std::fs::remove_file(&lock).unwrap();

        assert_eq!(result.outcome, Outcome::Failed, "{}", result.message);
        assert_eq!(result.exit_code, Some(128), "git's own status, not a guess");
        assert!(
            result.message.contains("reported a failure"),
            "{}",
            result.message
        );
        // The detail is Git's first stderr line, which names index.lock; a
        // generic "the reset failed" here would leave the user with nothing.
        let detail = result.details.expect("the first stderr line must be shown");
        assert!(detail.contains("index.lock"), "{detail}");
        // A failed reset is still a reason to re-read: the snapshot is what
        // the user sees next, and it must show the untouched working copy.
        let snapshot = result
            .snapshot
            .expect("a failed reset still re-reads state");
        assert!(snapshot.files.iter().any(|f| f.display == "b.txt"));
        // HEAD did not move: the reset failed, so the branch is still where
        // the preview found it and the working copy still holds the edit.
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "b changed\n"
        );
    }

    /// A conflicted index is a dirty set in its own right: both sides of the
    /// conflict belong in the hard-reset candidate list, because a hard reset
    /// overwrites them.
    #[test]
    fn a_conflicted_file_is_listed_as_a_hard_reset_candidate() {
        let root = crate::sequencer::tests::diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        // A conflict is the state a hard reset is most often wanted for, and
        // it is the one dirty shape the ordinary tracked/untracked filter
        // cannot see: both sides of the conflict are in the index, marked
        // unmerged rather than changed.
        let started = crate::sequencer::merge_start(&writes, &sessions, version, "side").unwrap();
        let conflicted = tracked_dirty_set(&sessions).unwrap();
        let names: Vec<String> = conflicted
            .iter()
            .map(|raw| model::display_name(raw))
            .collect();
        assert_eq!(
            names,
            vec!["base.txt"],
            "the conflicted path is the candidate"
        );
        // The same file is what the whole session reports as a conflict.
        let view = started.snapshot.expect("in-flight");
        let entry = view
            .files
            .iter()
            .find(|file| file.display == "base.txt")
            .expect("the conflicted file is in the snapshot");
        assert_eq!(entry.group, model::FileGroup::Conflict);
    }
}
