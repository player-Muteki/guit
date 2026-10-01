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
use crate::write::{self, OperationKind, OperationResult, Outcome, WriteState};
use crate::{branches, history, model, repo, runner, sequencer, session};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// The wire-level mode of a plain reset. `hard` is deliberately not
/// expressible here: reaching a hard reset means going through the clean
/// restore, which is bound to a whole computed plan rather than to a mode
/// flag, so no serialized request can reach it by accident.
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

/// A restore preview reads whole listings — the target tree, every untracked
/// path — so it takes the bound `status` and the gitlink listing take, not the
/// 64 KB default. A repository of roughly a thousand files passes the default
/// (measured while fixing the submodule listing), and a truncated listing would
/// read as "nothing is in the way".
const LISTING_OUTPUT_LIMIT: usize = runner::STATUS_OUTPUT_LIMIT;

/// One untracked path, in the granularity Git itself reported it. Git keeps a
/// repository of its own as one folded entry ending in `/` while it expands a
/// plain untracked directory file by file — 100 entries for `extra/` against the
/// single `nested/` — so the trailing separator *is* the report that this is
/// somebody else's repository, and no filesystem probing is needed to know it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Untracked {
    pub raw: Vec<u8>,
    pub repository: bool,
}

/// One path the current commit and the target disagree about, and whether the
/// target holds it — the letter Git gave, kept because it is the difference
/// between the restore writing this path and taking it away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Difference {
    pub raw: Vec<u8>,
    pub in_target: bool,
}

/// What the two steps of a clean restore would touch, in the granularity each
/// class was measured in. Nothing here is inferred from what Git is expected to
/// refuse: measured on the same shapes, `reset --hard` refuses nothing at all —
/// it overwrites an untracked file, destroys an untracked directory and destroys
/// a nested repository with its own `.git`, each with rc 0 and no warning.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Restoration {
    /// The commit the restore goes to, and the one it leaves, both full ids as
    /// Git resolved them — never the text that was typed.
    pub target_oid: String,
    pub head_oid: String,
    /// Every path the two trees disagree about.
    pub differences: Vec<Difference>,
    /// Every tracked change the working copy or the index is carrying: exactly
    /// what the restore throws away. Measured, not narrowed — a hand edit on a
    /// path the two trees agree about is discarded all the same, so intersecting
    /// this list with `differences` would promise "nothing is dropped" and then
    /// drop a file, and a path staged but never committed is dirty in the index
    /// only, which `clean` never lists and `reset --hard` removes from disk.
    pub discarded: Vec<Vec<u8>>,
    /// Untracked paths the restore writes, because the target holds the path
    /// itself or a path above it. A claim about scope, not about bytes: a file
    /// whose contents already match is written all the same, so "nothing
    /// changed there afterwards" never means "nothing was overwritten".
    pub overwritten: Vec<Untracked>,
    /// Ignored paths the target holds — the one exception to "the restore leaves
    /// ignored files alone". They are not in `overwritten`, because that list is
    /// the untracked listing taken with the ignore rules applied and Git does not
    /// call these untracked. The restore writes them all the same, so the preview
    /// names them before the write instead of letting the ignore rule imply they
    /// were safe.
    pub ignored_written: Vec<Untracked>,
    /// Untracked paths a fresh `git clean -nd` agrees to remove, less anything
    /// the restore writes — `clean` is silent about a path the reset has just
    /// made tracked, so promising it would be promising a thing Git will not do.
    pub removals: Vec<Untracked>,
    /// Untracked paths neither step touches: `clean` does not list a repository
    /// without a second force, and guit never adds one. These are stated as
    /// staying, with the reason, not as failures.
    pub left_behind: Vec<Untracked>,
    /// Repositories the restore would destroy or write through. The one class
    /// that refuses the operation instead of being listed in it.
    pub blocked: Vec<Untracked>,
}

impl Restoration {
    /// The refusal Git will not make on guit's behalf. `checkout` and
    /// `switch --detach` do block on this shape, but they move HEAD off the
    /// branch, so they cannot be the restore; `reset --hard` walks straight
    /// through. An ignored plain file the target tracks is not here — the restore
    /// writes it, and saying so belongs in the preview, not in a rejection. An
    /// ignored *repository* is here: a rule that sets a path aside says nothing
    /// about what a write through it destroys.
    pub(crate) fn guard(&self) -> Result<(), ProbeError> {
        let Some(first) = self.blocked.first() else {
            return Ok(());
        };
        let name = model::display_name(&first.raw);
        let subject = if self.blocked.len() == 1 {
            format!("`{name}` is a Git repository of its own")
        } else {
            format!(
                "`{name}` and {} other paths are Git repositories of their own",
                self.blocked.len() - 1
            )
        };
        Err(ProbeError::new(
            "reset_preview_repository",
            format!("{subject}; a clean restore neither removes one nor writes inside one, so the restore was refused."),
        ))
    }
}

/// Whether `parent` names a directory that `path` sits inside. The separator has
/// to be the first difference, or `src` would claim `srclist.txt`.
fn is_ancestor_dir(parent: &[u8], path: &[u8]) -> bool {
    matches!(path.strip_prefix(parent), Some(rest) if rest.first() == Some(&b'/'))
}

/// Whether the restore writes this path: the target holds the path itself, or
/// holds a path above it. The destruction happens at the directory level — the
/// target's `y`, a file, takes away everything under an untracked `y/` — so a
/// name-for-name comparison reports no obstacle exactly where a directory goes.
fn claimed_by_target(held: &BTreeSet<&[u8]>, raw: &[u8]) -> bool {
    held.contains(raw)
        || raw
            .iter()
            .enumerate()
            .any(|(index, byte)| *byte == b'/' && held.contains(&raw[..index]))
}

/// Whether the `git clean -nd` listing covers this path, as its own entry or as
/// a directory the listing folds several files into (`Would remove extra/`
/// stands for every file in it). The listing is the only source of the removal
/// promise, so a path Git did not list is never promised.
fn covered_by_clean(found: &[(Vec<u8>, bool)], raw: &[u8]) -> bool {
    found
        .iter()
        .any(|(candidate, _)| candidate == raw || is_ancestor_dir(candidate, raw))
}

/// One of the listings a restore plan is built from, as the exact bytes Git
/// separated with NULs. Every way the read can fail answers with a refusal, not
/// with an empty listing: a preview built on a read Git could not finish would
/// promise less than the restore touches, and a restore is not recoverable the
/// way a refused preview is.
fn read_listing(
    work_root: &Path,
    args: &[&str],
    purpose: &str,
) -> Result<Vec<Vec<u8>>, ProbeError> {
    let mut command = repo::user_git_command(work_root);
    command.args(args);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        LISTING_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if !output.status.success() {
        return Err(ProbeError::new(
            "reset_preview_failed",
            format!("Git would not give its list of {purpose}; the restore was refused."),
        ));
    }
    if output.truncated {
        return Err(ProbeError::new(
            "reset_preview_too_large",
            format!("Git's list of {purpose} was too large to read; the restore was refused."),
        ));
    }
    Ok(output
        .stdout
        .split(|byte| *byte == b'\0')
        .filter(|piece| !piece.is_empty())
        .map(|piece| piece.to_vec())
        .collect())
}

/// `diff --name-status -z --no-renames <head> <target>`: which paths the two
/// trees differ on, and which of them the target holds. Renames are turned off
/// because the pair record is a different `-z` shape, and the question a restore
/// asks is about paths, not about credit. A letter this does not recognise
/// refuses the whole preview rather than being skipped: the letter is what says
/// whether the restore writes the path or takes it away, so guessing one is
/// guessing what the operation does.
fn tree_differences(
    work_root: &Path,
    head: &str,
    target: &str,
) -> Result<Vec<Difference>, ProbeError> {
    let tokens = read_listing(
        work_root,
        &["diff", "--name-status", "-z", "--no-renames", head, target],
        "the difference between the target and the commit the branch is on",
    )?;
    let unreadable = || {
        ProbeError::new(
            "reset_preview_failed",
            "Git described that difference in a shape this preview does not read; the restore was refused.",
        )
    };
    if tokens.len() % 2 != 0 {
        return Err(unreadable());
    }
    let mut differences = Vec::with_capacity(tokens.len() / 2);
    for pair in tokens.chunks_exact(2) {
        if pair[0].len() != 1 {
            return Err(unreadable());
        }
        let in_target = match pair[0][0] {
            b'A' | b'M' | b'T' => true,
            b'D' => false,
            _ => return Err(unreadable()),
        };
        differences.push(Difference {
            raw: pair[1].clone(),
            in_target,
        });
    }
    Ok(differences)
}

/// Every path the target tree holds, exactly as Git lists it. A gitlink appears
/// as its own path with nothing below it, because `-r` does not descend into
/// another repository — which is also why the claim test needs this read and not
/// only the path difference.
fn target_paths(work_root: &Path, target: &str) -> Result<Vec<Vec<u8>>, ProbeError> {
    read_listing(
        work_root,
        &["ls-tree", "-r", "-z", "--name-only", target],
        "the paths the target holds",
    )
}

/// Turns one NUL-separated listing into the granularity Git reported: a folded
/// entry keeps its trailing separator as the report that this is somebody else's
/// repository.
fn as_untracked(raws: Vec<Vec<u8>>) -> Vec<Untracked> {
    raws.into_iter()
        .map(|raw| match raw.strip_suffix(b"/".as_slice()) {
            Some(directory) => Untracked {
                raw: directory.to_vec(),
                repository: true,
            },
            None => Untracked {
                raw,
                repository: false,
            },
        })
        .collect()
}

/// `ls-files --others --exclude-standard -z`: what is untracked, with the
/// repository's own ignore rules applied. `--exclude-standard` is not optional —
/// without it ignored files enter as untracked (5 entries against 3 on the same
/// repository) and the restore would promise to remove what the default
/// protection keeps.
fn untracked_paths(work_root: &Path) -> Result<Vec<Untracked>, ProbeError> {
    Ok(as_untracked(read_listing(
        work_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        "which files are untracked",
    )?))
}

/// `ls-files --others --ignored --exclude-standard -z`: the paths the ignore
/// rules cover, one entry per file and nothing else. This is the listing the
/// exception is computed from, because the default protection has exactly one
/// hole — a path the target holds is written by the restore even while a rule
/// covers it. `status --porcelain -z -uall --ignored` gives the same paths at the
/// same granularity, mixed into the whole working copy (101 entries to reach 2 of
/// them, each behind a three byte header), so the preview reads this one.
fn ignored_paths(work_root: &Path) -> Result<Vec<Untracked>, ProbeError> {
    Ok(as_untracked(read_listing(
        work_root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
        "the paths the repository's own rules set aside",
    )?))
}

/// The affected sets a clean restore is previewed from: six listings that each
/// answer one class of path, plus the one target resolution the ordinary reset
/// already uses, in the order the measurements set. Resolve first, because a
/// target that is not exactly one commit has nothing to be previewed against;
/// then the two tree reads, then the working copy, then what `clean` itself
/// agrees to remove, then the paths the ignore rules cover.
pub(crate) fn plan_restore(
    work_root: &Path,
    sessions: &session::SessionState,
    target: &str,
) -> Result<Restoration, ProbeError> {
    let target_oid = resolve_target(work_root, target)?;
    let head_oid = resolve_commit(work_root, "HEAD")
        .ok_or_else(|| ProbeError::new("reset_head", "HEAD does not name a commit."))?;
    let differences = tree_differences(work_root, &head_oid, &target_oid)?;
    let held_list = target_paths(work_root, &target_oid)?;
    let held = held_list
        .iter()
        .map(Vec::as_slice)
        .collect::<BTreeSet<&[u8]>>();
    let discarded = tracked_dirty_set(sessions)?;
    let removal_promise = write::clean_candidates(work_root, &[])?;
    let mut plan = Restoration {
        target_oid,
        head_oid,
        differences,
        discarded,
        ..Restoration::default()
    };
    for item in untracked_paths(work_root)? {
        if claimed_by_target(&held, &item.raw) {
            if item.repository {
                plan.blocked.push(item.clone());
            }
            plan.overwritten.push(item);
        } else if !item.repository && covered_by_clean(&removal_promise, &item.raw) {
            plan.removals.push(item);
        } else {
            // A repository Git folded into one entry is not in its own listing
            // of what to remove, so it stays — the promise follows the listing,
            // never the directory that contains it.
            plan.left_behind.push(item);
        }
    }
    for item in ignored_paths(work_root)? {
        if claimed_by_target(&held, &item.raw) {
            // The ignore rule says Git set this path aside; it does not say the
            // restore leaves it alone, because the target holds it. A repository
            // in this class is refused like any other — what gets destroyed is
            // not a question the ignore rules answer.
            if item.repository {
                plan.blocked.push(item.clone());
            }
            plan.ignored_written.push(item);
        }
    }
    Ok(plan)
}

/// One entry of a listing as the panel shows it: the exact path Git named,
/// plus the one fact a path cannot carry by itself — that this entry is
/// somebody else's repository.
fn untracked_name(item: &Untracked) -> String {
    let mut name = model::display_name(&item.raw);
    if item.repository {
        name.push_str(" (repository)");
    }
    name
}

fn untracked_names(list: &[Untracked]) -> Vec<String> {
    list.iter().map(untracked_name).collect()
}

/// The grouped lists a restore preview shows, each in the granularity the
/// reading that produced it reported. Only display names cross the boundary:
/// the paths themselves live in the ticket, and what the panel draws is built
/// from this one computation rather than from a second, narrower one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestorePreview {
    pub nonce: String,
    /// Both ids as Git resolved them, never the text that was typed.
    pub target_oid: String,
    pub head_oid: String,
    /// Tracked paths the current commit and the target disagree about.
    pub changed: Vec<String>,
    /// Local edits the restore drops — every dirty tracked path, whether or not
    /// the target moves that path.
    pub discarded: Vec<String>,
    /// Untracked paths the restore writes.
    pub overwritten: Vec<String>,
    /// Ignored paths the target holds anyway — the one class a rule does not
    /// set aside, so the preview owes them a line before the write, not after.
    pub ignored_written: Vec<String>,
    /// Untracked paths the second step removes.
    pub removed: Vec<String>,
    /// Untracked paths neither step touches, stated as staying.
    pub left_behind: Vec<String>,
    pub snapshot: session::SnapshotView,
}

/// Stage a clean restore: compute the plan, refuse what Git refuses to refuse,
/// and only then put the whole plan under a one-time nonce.
///
/// The refusal runs before the ticket exists, so a repository standing where
/// the target writes leaves no confirmation to click. The plan is moved into
/// the ticket unchanged — every set the preview lists above is a set the
/// confirmation re-reads, so a page cannot show one promise and bind another.
pub(crate) fn preview_restore(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    target: &str,
) -> Result<RestorePreview, ProbeError> {
    let (work_root, unborn) = sessions.commit_context(snapshot_version)?;
    if unborn {
        return Err(ProbeError::new(
            "reset_unborn",
            "Cannot restore before the first commit.",
        ));
    }
    if let Some(refusal) = sequencer::in_progress_message(sessions)? {
        return Err(ProbeError::new("reset_in_progress", refusal));
    }
    let plan = plan_restore(&work_root, sessions, target)?;
    plan.guard()?;
    let changed = plan
        .differences
        .iter()
        .map(|difference| model::display_name(&difference.raw))
        .collect();
    let discarded = plan
        .discarded
        .iter()
        .map(|raw| model::display_name(raw))
        .collect();
    let overwritten = untracked_names(&plan.overwritten);
    let ignored_written = untracked_names(&plan.ignored_written);
    let removed = untracked_names(&plan.removals);
    let left_behind = untracked_names(&plan.left_behind);
    let target_oid = plan.target_oid.clone();
    let head_oid = plan.head_oid.clone();
    let nonce = state.stage_restore(work_root, plan);
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    Ok(RestorePreview {
        nonce,
        target_oid,
        head_oid,
        changed,
        discarded,
        overwritten,
        ignored_written,
        removed,
        left_behind,
        snapshot,
    })
}

/// What the confirmation re-reads: the whole plan, built again by the same
/// construction that made the preview. Comparing every set rather than a
/// chosen few is the point — the promise the user clicked is the plan, and a
/// second, narrower re-read is the drift this module keeps refusing to create.
fn recheck_restore(
    sessions: &session::SessionState,
    work_root: &Path,
    wanted: &Restoration,
) -> write::Recheck {
    if let Some(refusal) = sequencer::in_progress_message(sessions)? {
        return Ok(Err(refusal));
    }
    let now = plan_restore(work_root, sessions, &wanted.target_oid)?;
    // The refusal Git will not make is made again here: anything can put a
    // repository where the target writes between the preview and this click,
    // and the reset walks through it with rc 0 and no warning.
    if let Err(refusal) = now.guard() {
        return Ok(Err(refusal.message));
    }
    let moved = |what: &str| {
        Ok(Err(format!(
            "{what} changed after the preview; nothing was restored. Preview the restore again."
        )))
    };
    if now.head_oid != wanted.head_oid {
        return moved("The branch");
    }
    if now.differences != wanted.differences {
        return moved("Which paths the target disagrees about");
    }
    if now.discarded != wanted.discarded {
        return moved("The local changes the restore would drop");
    }
    if now.overwritten != wanted.overwritten
        || now.ignored_written != wanted.ignored_written
        || now.removals != wanted.removals
        || now.left_behind != wanted.left_behind
    {
        return moved("The untracked files");
    }
    Ok(Ok(()))
}

/// The two steps a clean restore runs, inside the one held write slot, and the
/// two conditions they are judged by afterwards. They are not atomic and nothing
/// here pretends they are: the second step asks Git what it still agrees to
/// remove *after* the reset, because the reset is what takes a path into the tree
/// where `clean` then goes silent. A path Git no longer offers is reported as
/// left where it is — not as a failure, not as a removal, and never with a second
/// force added to make Git say yes.
fn run_restore_steps(
    state: &WriteState,
    sessions: &session::SessionState,
    work_root: &Path,
    plan: &Restoration,
) -> Result<write::Ran, ProbeError> {
    let target = short(&plan.target_oid);
    let reset = write::ran_from(
        sequencer::run_git(
            work_root,
            false,
            &["reset", "--hard", &plan.target_oid],
            state,
        ),
        write::Wording {
            ok: format!("Restored the working copy to {target}."),
            failed: "git reset --hard reported a failure.".to_owned(),
            cancelled: "Cancelled while the Git process was running.".to_owned(),
        },
    )?;
    if reset.outcome != Outcome::Success {
        // The removal is not attempted: the plan the user confirmed describes a
        // tree this reset did not produce, and a half-run `clean` against it
        // would delete files nothing was previewed for.
        return Ok(write::Ran {
            message: format!(
                "{} The untracked files were not removed, so this is not a clean restore.",
                reset.message
            ),
            ..reset
        });
    }
    let promised = plan
        .removals
        .iter()
        .map(|item| item.raw.clone())
        .collect::<Vec<_>>();
    let removal = if promised.is_empty() {
        write::Ran::ok(
            format!(
                "{} No untracked file was listed for removal.",
                reset.message
            ),
            reset.exit_code,
        )
    } else {
        match removal_after_reset(state, work_root, &target, &reset, &promised) {
            Ok(ran) => ran,
            Err(error) => unfinished_removal(&reset, &error),
        }
    };
    let aftermath = read_aftermath(sessions, work_root, state.cancel_flag(), &plan.target_oid);
    let outcome = restore_verdict(removal.outcome, aftermath.clean());
    Ok(write::Ran {
        outcome,
        message: format!("{}{}", removal.message, aftermath.sentence(&promised)),
        ..removal
    })
}

/// The one rule deciding what a finished restore is allowed to claim. A
/// cancellation stays the cancellation the user asked for even if the tree
/// happens to settle afterwards, and nothing is called clean unless Git
/// answered both conditions yes: one step ran and the promise was not kept is
/// its own answer, because the reset is not undone by a removal that failed.
fn restore_verdict(removal: Outcome, settled: bool) -> Outcome {
    match (removal, settled) {
        (Outcome::Cancelled, _) => Outcome::Cancelled,
        (Outcome::Success, true) => Outcome::Success,
        _ => Outcome::Partial,
    }
}

/// The removal, asked the way a destructive step may be asked only once the
/// first one has succeeded: `clean -nd` is re-run over exactly the promised
/// paths, and only what it still offers is handed to `clean -fd`. A promise Git
/// has taken back is reported as left where it is rather than forced.
fn removal_after_reset(
    state: &WriteState,
    work_root: &Path,
    target: &str,
    reset: &write::Ran,
    promised: &[Vec<u8>],
) -> Result<write::Ran, ProbeError> {
    let offered = write::clean_candidates(work_root, promised)?;
    let going = promised
        .iter()
        .filter(|raw| covered_by_clean(&offered, raw))
        .cloned()
        .collect::<Vec<_>>();
    if going.is_empty() {
        return Ok(write::Ran::ok(
            format!(
                "{} None of the {} untracked path(s) the preview listed are offered by git clean.",
                reset.message,
                promised.len()
            ),
            None,
        ));
    }
    step_two(state, work_root, target, reset, &going)
}

/// The answer when the removal cannot even be asked: the reset is a fact the
/// reader has to be told, and an error escaping here would report a command
/// that did nothing over a working copy that already moved.
fn unfinished_removal(reset: &write::Ran, error: &ProbeError) -> write::Ran {
    write::Ran {
        outcome: Outcome::Partial,
        message: format!(
            "{} The removal did not complete: {}.",
            reset.message, error.message
        ),
        details: None,
        exit_code: None,
        suggestion: None,
    }
}

/// The second Git process, with the wording of a step whose result only means
/// something next to the first one's.
fn step_two(
    state: &WriteState,
    work_root: &Path,
    target: &str,
    reset: &write::Ran,
    going: &[Vec<u8>],
) -> Result<write::Ran, ProbeError> {
    let clean = write::ran_from(
        write::run_git_paths(work_root, &["clean", "-fd"], going, state.cancel_flag()),
        write::Wording {
            ok: format!("Removed {} untracked item(s).", going.len()),
            failed: "git clean reported a failure.".to_owned(),
            cancelled: "Cancelled while the Git process was running.".to_owned(),
        },
    )?;
    let message = match clean.outcome {
        Outcome::Success => format!("{} {}", reset.message, clean.message),
        _ => format!(
            "{} The working copy reached {target}; the untracked files were not all removed.",
            clean.message
        ),
    };
    Ok(write::Ran { message, ..clean })
}

/// How many leftover paths the aftermath names before summarising the residue.
const AFTERMATH_DISPLAY_LIMIT: usize = 8;

/// The two conditions a clean restore is judged by, read apart because they
/// answer different questions and can disagree: the working copy's own state
/// says what is still there, `diff --quiet <target>` says whether the tracked
/// content is the target's. A restore that leaves somebody else's repository
/// where it stands passes the second and fails the first; a repository written
/// to during the two steps fails the second while the first has nothing new to
/// say. Neither answer implies the other, and a read that will not answer is
/// never read as a clean repository.
struct Aftermath {
    leftovers: Vec<Vec<u8>>,
    status_answered: bool,
    matches_target: Option<bool>,
}

impl Aftermath {
    fn clean(&self) -> bool {
        self.status_answered && self.leftovers.is_empty() && self.matches_target == Some(true)
    }

    /// Which path is still standing, by Git's own later answer rather than by
    /// what this program handed to `clean` a moment ago — including the case
    /// where a folded directory is listed instead of the file inside it.
    fn still_there(&self, raw: &[u8]) -> bool {
        self.leftovers
            .iter()
            .any(|left| left.as_slice() == raw || is_ancestor_dir(left, raw))
    }

    /// The sentence the operation owes after the two steps: which condition
    /// holds, what is outside it, and how many of the promised paths are still
    /// there. It never says "restored" by itself.
    fn sentence(&self, promised: &[Vec<u8>]) -> String {
        if !self.status_answered || self.matches_target.is_none() {
            return " Git would not answer both conditions afterwards, so this is not reported as a clean restore."
                .to_owned();
        }
        if self.clean() {
            return " The working copy is clean and matches the target.".to_owned();
        }
        let mut parts = Vec::new();
        if !self.leftovers.is_empty() {
            let named = self
                .leftovers
                .iter()
                .take(AFTERMATH_DISPLAY_LIMIT)
                .map(|raw| model::display_name(raw))
                .collect::<Vec<_>>()
                .join(", ");
            let more = self.leftovers.len() - AFTERMATH_DISPLAY_LIMIT.min(self.leftovers.len());
            let list = if more == 0 {
                named
            } else {
                format!("{named}, and {more} more")
            };
            parts.push(format!(
                "{} path(s) are still there: {list}",
                self.leftovers.len()
            ));
        }
        if self.matches_target == Some(false) {
            parts.push("the tracked content is not the target's".to_owned());
        }
        let removal = if promised.is_empty() {
            String::new()
        } else {
            let unremoved = promised.iter().filter(|raw| self.still_there(raw)).count();
            if unremoved == 0 {
                format!(
                    " All {} path(s) promised for removal are gone.",
                    promised.len()
                )
            } else {
                format!(
                    " {unremoved} of the {} path(s) promised for removal are not.",
                    promised.len()
                )
            }
        };
        format!(
            " It is not a clean restore: {}.{}",
            parts.join("; "),
            removal
        )
    }
}

/// Both reads happen inside the held write slot, after the two steps: the
/// answer is about the tree this operation just made, and a snapshot taken
/// before it would describe a tree somebody else may have left.
fn read_aftermath(
    sessions: &session::SessionState,
    work_root: &Path,
    cancelled: &AtomicBool,
    target_oid: &str,
) -> Aftermath {
    let (leftovers, status_answered) = match write::status_index(sessions) {
        Ok(entries) => (entries.keys().cloned().collect::<Vec<_>>(), true),
        Err(_) => (Vec::new(), false),
    };
    let matches_target = repo::git(
        work_root,
        repo::GitRun::read(&["diff", "--quiet", target_oid], cancelled),
    )
    .ok()
    .filter(|output| !output.truncated)
    .map(|output| output.status.success());
    Aftermath {
        leftovers,
        status_answered,
        matches_target,
    }
}

/// The clean restore's confirmation: the ticket goes first, the whole plan is
/// re-read against it, and only then do the two Git steps run — each recorded
/// with what it actually did.
pub(crate) fn restore_clean(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_restore(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_restore(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    write::confirm(
        state,
        sessions,
        OperationKind::Restore,
        nonce,
        write::Refusals {
            expired: "That confirmation has expired; preview the restore again.",
            session_changed: "A different repository is open now; preview the restore again.",
            cancelled_before_git: "Cancelled before Git ran; nothing was changed.",
        },
        |preview| match preview.bound {
            write::Bound::Restore { plan } => Some((preview.work_root, plan)),
            _ => None,
        },
        |work_root, plan| recheck_restore(sessions, work_root, plan),
        |work_root, plan| run_restore_steps(state, sessions, work_root, plan),
    )
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
        // A well-formed but nonexistent commit is caught at restore preview too
        // (soft/mixed leave it to Git's own failure reporting).
        let ghost = "deadbeef".repeat(5);
        let error = preview_restore(&writes, &sessions, version, &ghost).unwrap_err();
        assert_eq!(error.code.as_str(), "reset_target_absent");
        // And a branch name is not a legitimate target either: the ticket
        // would bind the commit it points at today and a different one later.
        let error = preview_restore(&writes, &sessions, version, "main").unwrap_err();
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
        let preview = preview_restore(&writes, &sessions, version, abbreviation).unwrap();
        assert_eq!(preview.target_oid, c1);
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
        let preview = preview_restore(&writes, &sessions, version, &c1.to_uppercase()).unwrap();
        assert_eq!(preview.target_oid, c1);
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
        let error = preview_restore(&writes, &sessions, version, &blob).unwrap_err();
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
        let error = preview_restore(&writes, &sessions, version, &prefix).unwrap_err();
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
        // The restore entry reports the same fact as an error code, because the
        // caller has nowhere to show a preview it cannot produce. The refusal
        // above re-read state, so the next call needs the newer version.
        let version = soft.snapshot.expect("re-read").version;
        let error = preview_restore(&writes, &sessions, version, "main").unwrap_err();
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

    /// The ticket is bound to the repository that produced it. Switching to
    /// another open repository and then confirming must be refused even
    /// though the nonce, the target and the dirty set would all still match.
    #[test]
    fn a_ticket_does_not_survive_switching_repositories() {
        let (root, target) = restore_repo();
        let second = restore_repo().0;
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        // The two repositories are clones of one fixture: same shape, same
        // commit ids, same dirty set. Only the identity check can tell them
        // apart, so the ticket binding itself to a work root is the only thing
        // standing between a preview of one repository and a restore of
        // another.
        session::open(&sessions, second.path()).unwrap();
        let second_head = read(second.path(), &["rev-parse", "HEAD"]);
        let refused = restore_clean(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(
            refused.message.contains("different repository"),
            "{}",
            refused.message
        );
        // The second repository's working copy is untouched, and it is the
        // *open* one, so a wrong restore here would be the most destructive
        // bug this module could have.
        assert_eq!(read(second.path(), &["rev-parse", "HEAD"]), second_head);
        assert_eq!(
            std::fs::read_to_string(second.path().join("plain.txt")).unwrap(),
            "untracked\n",
            "the newly opened repository must be untouched"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("plain.txt")).unwrap(),
            "untracked\n",
            "nor may the confirmed one be cleaned"
        );
    }

    fn init(dir: &Path) {
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        git(dir, &["config", "user.name", "guit test"]);
        git(dir, &["config", "user.email", "test@example.invalid"]);
    }

    /// A file under whatever directories its name names, so a test can write a
    /// path Git is about to report without caring what the tree held before.
    fn write_at(dir: &Path, relative: &str, body: &str) {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn head(dir: &Path) -> String {
        read(dir, &["rev-parse", "HEAD"])
    }

    /// Commit whatever the working tree holds, the way the measurements did, and
    /// answer with the commit id it became.
    fn commit_all(dir: &Path, message: &str) -> String {
        git(dir, &["add", "-A", "--"]);
        git(dir, &["commit", "-qm", message]);
        head(dir)
    }

    /// A repository inside the working tree, with a committed file of its own:
    /// the shape `reset --hard` destroys with rc 0 and no warning, and the shape
    /// `ls-files --others` reports as one folded entry instead of a file list.
    fn repository_in(dir: &Path, name: &str) {
        let inside = dir.join(name);
        std::fs::create_dir_all(&inside).unwrap();
        init(&inside);
        write_at(&inside, "own.txt", "tracked inside another repository\n");
        git(&inside, &["add", "-A", "--"]);
        git(&inside, &["commit", "-qm", "the nested head"]);
    }

    fn names(list: &[Vec<u8>]) -> Vec<String> {
        list.iter().map(|raw| model::display_name(raw)).collect()
    }

    /// The plan needs a session for the one read that is not a listing of the
    /// repository: which paths the working copy is dirty on.
    fn plan_for(dir: &Path, target: &str) -> Restoration {
        let (_, sessions, version) = state_and_session(dir);
        let (work_root, _) = sessions.commit_context(version).unwrap();
        plan_restore(&work_root, &sessions, target).unwrap()
    }

    /// Every class a clean restore has to name, in one repository: a tracked
    /// edit the target drops, an untracked file the target writes, an untracked
    /// file a `clean` removes, and a repository neither step may touch.
    #[test]
    fn a_restore_plan_names_what_the_restore_writes_and_what_a_clean_removes() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "keep\n");
        write_at(dir, "gone.txt", "the target's own bytes\n");
        let target = commit_all(dir, "the target holds both");
        write_at(dir, "keep.txt", "committed differently\n");
        git(dir, &["rm", "-q", "--", "gone.txt"]);
        let head_oid = commit_all(dir, "the tree dropped one file and rewrote the other");
        write_at(dir, "keep.txt", "edited by hand\n");
        write_at(dir, "gone.txt", "written again by hand\n");
        write_at(dir, "plain.txt", "untracked\n");
        repository_in(dir, "nested");

        let plan = plan_for(dir, &target);
        assert_eq!(plan.target_oid, target);
        assert_eq!(plan.head_oid, head_oid);
        assert_eq!(head(dir), head_oid, "a preview writes nothing");
        let differences: Vec<String> = plan
            .differences
            .iter()
            .map(|difference| {
                format!(
                    "{} {}",
                    model::display_name(&difference.raw),
                    if difference.in_target {
                        "in the target"
                    } else {
                        "dropped"
                    }
                )
            })
            .collect();
        assert_eq!(
            differences,
            ["gone.txt in the target", "keep.txt in the target",]
        );
        // Two reads answer this one question: status says keep.txt is dirty, the
        // difference says the target moves it. gone.txt is dirty in no sense a
        // tracked listing can see, because nothing tracks it yet.
        assert_eq!(names(&plan.discarded), ["keep.txt"]);
        assert_eq!(untracked_names(&plan.overwritten), ["gone.txt"]);
        assert_eq!(untracked_names(&plan.removals), ["plain.txt"]);
        assert_eq!(untracked_names(&plan.left_behind), ["nested (repository)"]);
        assert!(plan.blocked.is_empty());
        plan.guard()
            .expect("a repository nobody is writing over is left behind, not refused");
    }

    /// `clean -nd` answers one folded line for a whole untracked directory, and
    /// one of the files under it is written by the restore rather than removed.
    /// The plan splits them, because the promise a user confirms is a promise
    /// about files.
    #[test]
    fn a_folded_untracked_directory_is_split_between_the_write_and_the_removal() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "keep\n");
        write_at(dir, "extra/wanted.txt", "the target's own bytes\n");
        let target = commit_all(dir, "the target holds a file inside a directory");
        git(dir, &["rm", "-q", "-r", "--", "extra"]);
        commit_all(dir, "the whole directory dropped");
        write_at(dir, "extra/wanted.txt", "written again by hand\n");
        write_at(dir, "extra/other.txt", "and a sibling nobody tracked\n");

        let plan = plan_for(dir, &target);
        let folded = write::clean_candidates(dir, &[]).unwrap();
        assert_eq!(
            names(
                &folded
                    .iter()
                    .map(|(raw, _)| raw.clone())
                    .collect::<Vec<Vec<u8>>>()
            ),
            ["extra"],
            "Git's own listing stands for the whole directory"
        );
        assert_eq!(untracked_names(&plan.overwritten), ["extra/wanted.txt"]);
        assert_eq!(untracked_names(&plan.removals), ["extra/other.txt"]);
        assert!(plan.left_behind.is_empty());
        assert!(plan.blocked.is_empty());
    }

    /// The one class that is a refusal rather than a line in a preview: a
    /// repository standing where the target writes. The test then runs the
    /// command guit refuses to run, so the refusal stays about a loss that was
    /// measured rather than a rule nobody can account for.
    #[test]
    fn a_repository_where_the_restore_writes_is_refused_before_anything_is_chosen() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "keep\n");
        write_at(dir, "y", "the target's own bytes\n");
        let target = commit_all(dir, "y is a file in the target");
        git(dir, &["rm", "-q", "--", "y"]);
        commit_all(dir, "y dropped from the tree");
        repository_in(dir, "y");

        let plan = plan_for(dir, &target);
        assert_eq!(untracked_names(&plan.overwritten), ["y (repository)"]);
        let refusal = plan.guard().expect_err("the plan refuses");
        assert_eq!(refusal.code.as_str(), "reset_preview_repository");
        assert!(refusal.message.contains("`y`"), "{}", refusal.message);
        // Measured, not assumed: the very command refuses to run destroys the
        // repository, its history and its own working copy, silently.
        git(dir, &["reset", "--hard", &target]);
        assert!(
            !dir.join("y/own.txt").exists(),
            "a restore was expected to take the nested file with it"
        );
    }

    /// Going to the commit the branch is already on moves no tracked path, and
    /// still has a removal to promise: the second step answers for itself.
    #[test]
    fn a_restore_to_the_commit_head_is_on_claims_no_tracked_path() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "keep\n");
        let target = commit_all(dir, "one commit");
        write_at(dir, "plain.txt", "untracked\n");

        let plan = plan_for(dir, &target);
        assert_eq!(plan.target_oid, plan.head_oid);
        assert!(plan.differences.is_empty());
        assert!(plan.discarded.is_empty());
        assert!(plan.overwritten.is_empty());
        assert_eq!(untracked_names(&plan.removals), ["plain.txt"]);
    }

    /// The ignore rules are applied before anything is listed, so an ignored
    /// file the target does not hold enters none of the sets: the restore neither
    /// promises to remove it nor counts it as something standing in the way.
    #[test]
    fn an_ignored_file_is_in_none_of_the_restore_lists() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, ".gitignore", "secret.txt\n");
        write_at(dir, "keep.txt", "keep\n");
        let target = commit_all(dir, "the ignore rule is committed");
        write_at(dir, "secret.txt", "not for the panel\n");
        write_at(dir, "plain.txt", "untracked\n");

        let plan = plan_for(dir, &target);
        assert_eq!(untracked_names(&plan.removals), ["plain.txt"]);
        assert!(plan.overwritten.is_empty());
        assert!(plan.ignored_written.is_empty());
        assert!(plan.left_behind.is_empty());
    }

    /// The one hole in that protection: a path the ignore rules cover which the
    /// target nevertheless holds. It is named in a set of its own rather than in
    /// `overwritten`, because the untracked listing is taken with those same rules
    /// applied and Git does not call this path untracked — and the restore writes
    /// it all the same.
    #[test]
    fn an_ignored_path_the_target_holds_is_named_before_the_write() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, ".gitignore", "built.txt\n");
        write_at(dir, "built.txt", "the target's own bytes\n");
        // `add -A` skips it — the rule is already in place. The shape this test is
        // about is a path the rules cover *and* the target tracks, so it goes in by
        // force, and the refusal below would otherwise be built on a tree that never
        // held the path.
        git(dir, &["add", "-f", "--", "built.txt"]);
        let target = commit_all(dir, "built.txt tracked despite the rule");
        git(dir, &["rm", "--cached", "-q", "--", "built.txt"]);
        commit_all(dir, "built.txt dropped from the tree, and ignored");
        write_at(dir, "built.txt", "written by hand since\n");
        write_at(dir, "plain.txt", "untracked\n");

        let plan = plan_for(dir, &target);
        assert_eq!(untracked_names(&plan.ignored_written), ["built.txt"]);
        assert!(plan.overwritten.is_empty(), "not counted twice");
        assert!(plan.blocked.is_empty());
        assert_eq!(untracked_names(&plan.removals), ["plain.txt"]);
        // Measured, not inferred: the ignore rule does not keep the file out of
        // the write, so the sentence the preview owes is "this will be written".
        git(dir, &["reset", "--hard", &target]);
        assert_eq!(
            std::fs::read_to_string(dir.join("built.txt")).unwrap(),
            "the target's own bytes\n"
        );
    }

    /// A repository the rules set aside is still a repository: the refusal does
    /// not ask what the ignore file says, only what the write would destroy.
    #[test]
    fn an_ignored_repository_the_target_writes_is_refused_too() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, ".gitignore", "y/\n");
        write_at(dir, "y", "the target's own bytes\n");
        let target = commit_all(dir, "y is a file in the target");
        git(dir, &["rm", "-q", "--", "y"]);
        commit_all(dir, "y dropped from the tree");
        repository_in(dir, "y");

        let plan = plan_for(dir, &target);
        assert_eq!(untracked_names(&plan.ignored_written), ["y (repository)"]);
        let refusal = plan.guard().expect_err("the plan refuses");
        assert_eq!(refusal.code.as_str(), "reset_preview_repository");
        assert!(refusal.message.contains("`y`"), "{}", refusal.message);
        assert!(
            dir.join("y/own.txt").exists(),
            "a refusal runs nothing, ignored or not"
        );
    }

    /// The plan is built on the same target resolution the ordinary reset uses,
    /// so a branch name and every revspec are refused before one listing runs.
    #[test]
    fn a_restore_plan_refuses_a_target_that_is_not_exactly_one_commit() {
        let root = dirty_repo();
        let dir = root.path();
        let (_, sessions, version) = state_and_session(dir);
        let (work_root, _) = sessions.commit_context(version).unwrap();
        for (typed, code) in [
            ("main", "reset_target_shape"),
            ("0000000", "reset_target_absent"),
        ] {
            let refusal = plan_restore(&work_root, &sessions, typed)
                .err()
                .unwrap_or_else(|| panic!("{typed} was accepted as a target"));
            assert_eq!(refusal.code.as_str(), code, "{}", refusal.message);
        }
    }

    /// Every class a clean restore owes a line about, listed by the preview in
    /// the granularity the reading that produced it reported — and with the ids
    /// Git resolved rather than the text that was typed.
    #[test]
    fn a_restore_preview_names_every_class_it_binds() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "keep\n");
        write_at(dir, "gone.txt", "the target's own bytes\n");
        let target = commit_all(dir, "the target holds both");
        write_at(dir, "keep.txt", "committed differently\n");
        git(dir, &["rm", "-q", "--", "gone.txt"]);
        let head_oid = commit_all(dir, "the tree dropped one file and rewrote the other");
        write_at(dir, "keep.txt", "edited by hand\n");
        write_at(dir, "gone.txt", "written again by hand\n");
        write_at(dir, "plain.txt", "untracked\n");
        repository_in(dir, "nested");

        let (writes, sessions, version) = state_and_session(dir);
        let typed = target.chars().take(8).collect::<String>();
        let preview = preview_restore(&writes, &sessions, version, &typed).unwrap();
        assert_eq!(preview.target_oid, target, "the typed text is not the id");
        assert_eq!(preview.head_oid, head_oid);
        assert_eq!(preview.changed, ["gone.txt", "keep.txt"]);
        assert_eq!(preview.discarded, ["keep.txt"]);
        assert_eq!(preview.overwritten, ["gone.txt"]);
        assert!(preview.ignored_written.is_empty());
        assert_eq!(preview.removed, ["plain.txt"]);
        assert_eq!(preview.left_behind, ["nested (repository)"]);
        assert_eq!(head(dir), head_oid, "a preview writes nothing");
    }

    /// The list the page shows and the set the confirmation re-reads are one
    /// computation, in one order: a preview that displayed less than the ticket
    /// binds would have to be built twice to pass this, and the double build is
    /// what the shared `Restoration` rules out.
    #[test]
    fn a_restore_ticket_binds_the_very_sets_the_preview_lists() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "keep\n");
        write_at(dir, "gone.txt", "the target's own bytes\n");
        let target = commit_all(dir, "the target holds both");
        git(dir, &["rm", "-q", "--", "gone.txt"]);
        commit_all(dir, "the tree dropped one file");
        write_at(dir, "gone.txt", "written again by hand\n");
        write_at(dir, "plain.txt", "untracked\n");
        repository_in(dir, "nested");

        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        let ticket = writes
            .take_bound(&preview.nonce)
            .expect("the preview stages a ticket");
        let write::Bound::Restore { plan } = ticket.bound else {
            panic!("a restore preview staged a ticket for another operation");
        };
        assert_eq!(plan.target_oid, preview.target_oid);
        assert_eq!(plan.head_oid, preview.head_oid);
        assert_eq!(untracked_names(&plan.overwritten), preview.overwritten);
        assert_eq!(untracked_names(&plan.removals), preview.removed);
        assert_eq!(untracked_names(&plan.left_behind), preview.left_behind);
        assert_eq!(names(&plan.discarded), preview.discarded);
        assert_eq!(
            plan.differences
                .iter()
                .map(|difference| model::display_name(&difference.raw))
                .collect::<Vec<_>>(),
            preview.changed
        );
    }

    /// The guard runs before the ticket exists, so the one case that must not
    /// be confirmed leaves nothing to confirm: no nonce is returned to replay,
    /// and no repository is staged for deletion.
    #[test]
    fn a_refused_restore_preview_stages_no_ticket() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "keep\n");
        write_at(dir, "y", "the target's own bytes\n");
        let target = commit_all(dir, "y is a file in the target");
        git(dir, &["rm", "-q", "--", "y"]);
        commit_all(dir, "y dropped from the tree");
        repository_in(dir, "y");

        let (writes, sessions, version) = state_and_session(dir);
        let refusal = preview_restore(&writes, &sessions, version, &target)
            .expect_err("a repository in the way is refused");
        assert_eq!(refusal.code.as_str(), "reset_preview_repository");
        assert!(refusal.message.contains("`y`"), "{}", refusal.message);
        assert!(
            writes.take_bound("").is_none(),
            "there is no staged restore to take"
        );
        assert!(
            dir.join("y/own.txt").exists(),
            "a refusal runs nothing, ignored or not"
        );
    }

    /// The two refusals the ordinary hard preview already makes are the restore
    /// preview's too: there is no tree to restore to before the first commit,
    /// and a merge in flight is not a state a reset should overwrite.
    #[test]
    fn a_restore_preview_refuses_where_a_reset_would_have_no_answer() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        let (writes, sessions, version) = state_and_session(dir);
        let refusal = preview_restore(&writes, &sessions, version, "0000000")
            .expect_err("an unborn head has no restore");
        assert_eq!(refusal.code.as_str(), "reset_unborn");

        let root = crate::sequencer::tests::diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let started = crate::sequencer::merge_start(&writes, &sessions, version, "side").unwrap();
        let version = started.snapshot.expect("the merge is in flight").version;
        let refusal = preview_restore(&writes, &sessions, version, &head(dir))
            .expect_err("a merge in flight is not a preview");
        assert_eq!(refusal.code.as_str(), "reset_in_progress");
    }

    /// The one exception to "the restore leaves ignored files alone" is not a
    /// reason to refuse, so it has to reach the page as its own line — a list
    /// the panel could otherwise fold into "nothing untracked was touched".
    #[test]
    fn a_restore_preview_says_which_ignored_path_it_writes() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, ".gitignore", "built.txt\n");
        write_at(dir, "built.txt", "the target's own bytes\n");
        // `add -f` because the rule is already in place and `add -A` would skip
        // the very path this fixture is about.
        git(dir, &["add", "-f", "--", "built.txt"]);
        let target = commit_all(dir, "built.txt tracked despite the rule");
        git(dir, &["rm", "--cached", "-q", "--", "built.txt"]);
        commit_all(dir, "built.txt dropped from the tree, and ignored");
        write_at(dir, "built.txt", "written by hand since\n");
        write_at(dir, "plain.txt", "untracked\n");

        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        assert_eq!(preview.ignored_written, ["built.txt"]);
        assert!(preview.overwritten.is_empty(), "not counted twice");
        assert_eq!(preview.removed, ["plain.txt"]);
    }

    /// A fixture the two steps have something to do in: one committed edit to
    /// drop, one local edit to throw away, one untracked file to remove.
    fn restore_repo() -> (tempfile::TempDir, String) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "the target's own bytes\n");
        let target = commit_all(dir, "the restore goes here");
        write_at(dir, "keep.txt", "committed since\n");
        commit_all(dir, "a commit the restore steps over");
        write_at(dir, "keep.txt", "an edit nobody committed\n");
        write_at(dir, "plain.txt", "untracked\n");
        (root, target)
    }

    /// Both steps, run for real: HEAD is at the target, the file holds the
    /// target's bytes rather than the hand edit, and the named untracked file is
    /// off the disk. The message answers for two Git processes, not one.
    #[test]
    fn a_confirmed_restore_runs_the_reset_and_then_the_bounded_clean() {
        let (root, target) = restore_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        assert_eq!(preview.discarded, ["keep.txt"]);
        assert_eq!(preview.removed, ["plain.txt"]);

        let result = restore_clean(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert!(
            result.message.contains("Restored the working copy")
                && result.message.contains("Removed 1 untracked item(s)"),
            "{}",
            result.message
        );
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), target, "the reset ran");
        assert_eq!(
            std::fs::read_to_string(dir.join("keep.txt")).unwrap(),
            "the target's own bytes\n"
        );
        assert!(!dir.join("plain.txt").exists(), "the clean ran");
    }

    /// Going to the commit HEAD is already on is still a restore. The tree
    /// difference it claims is empty, yet `reset --hard` drops every local edit
    /// anyway — including the one on a path the two trees agree about — so the
    /// preview owes that path a line, and the removal answers for itself.
    #[test]
    fn a_restore_to_the_current_commit_still_discards_and_still_removes() {
        let (root, _) = restore_repo();
        let dir = root.path();
        let current = head(dir);
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &current).unwrap();
        assert!(preview.changed.is_empty());
        assert_eq!(preview.discarded, ["keep.txt"]);
        assert_eq!(preview.removed, ["plain.txt"]);

        let result = restore_clean(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), current);
        assert_eq!(
            std::fs::read_to_string(dir.join("keep.txt")).unwrap(),
            "committed since\n",
            "the hand edit on a path the target does not move is gone, as promised"
        );
        assert!(!dir.join("plain.txt").exists());
    }

    /// A file appearing after the preview is nobody's business to delete, and
    /// the preview's business to refuse: the plan the user read no longer
    /// describes the tree, so both steps stay unrun — and the ticket is spent
    /// anyway, so the next answer has to come from a fresh preview.
    #[test]
    fn a_restore_refuses_a_tree_that_moved_after_the_preview() {
        let (root, target) = restore_repo();
        let dir = root.path();
        let before = head(dir);
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        let nonce = preview.nonce;
        write_at(dir, "arrived-later.txt", "in no preview\n");

        let result = restore_clean(&writes, &sessions, nonce.clone()).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected, "{}", result.message);
        assert!(
            result.message.contains("The untracked files changed"),
            "{}",
            result.message
        );
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), before, "nothing ran");
        assert!(dir.join("plain.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("keep.txt")).unwrap(),
            "an edit nobody committed\n"
        );
        let replay = restore_clean(&writes, &sessions, nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(
            replay.message.contains("expired"),
            "a spent ticket stays spent: {}",
            replay.message
        );
    }

    /// The reset is the step that decides whether the removal happens at all.
    /// A failed `reset --hard` leaves the tree wherever Git abandoned it, and a
    /// `clean` aimed at the confirmed list would then delete files that were
    /// only ever previewed against a tree that does not exist.
    #[test]
    fn a_restore_that_cannot_reset_does_not_clean() {
        let (root, target) = restore_repo();
        let dir = root.path();
        let before = head(dir);
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        let lock = dir.join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let result = restore_clean(&writes, &sessions, preview.nonce).unwrap();
        std::fs::remove_file(&lock).unwrap();

        assert_eq!(result.outcome, Outcome::Failed, "{}", result.message);
        assert_eq!(result.exit_code, Some(128), "git's own status, not a guess");
        assert!(
            result.message.contains("were not removed"),
            "the second step is named as unrun: {}",
            result.message
        );
        assert!(dir.join("plain.txt").exists(), "the clean never ran");
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), before);
    }

    /// Both steps ran, the tree reached the target, and the result is still not
    /// a clean restore: a repository that `clean` will not list without a second
    /// force stays where it stands. That is reported as what it is — one promise
    /// kept, the other not — rather than as a success with a longer sentence.
    #[test]
    fn a_restore_that_leaves_a_protected_repository_reports_a_partial_result() {
        let (root, target) = restore_repo();
        let dir = root.path();
        repository_in(dir, "nested");
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        assert_eq!(preview.removed, ["plain.txt"]);
        assert_eq!(preview.left_behind, ["nested (repository)"]);

        let result = restore_clean(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Partial, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), target, "the reset ran");
        assert!(!dir.join("plain.txt").exists(), "the removal ran too");
        assert!(
            dir.join("nested/own.txt").exists(),
            "the protected one stays"
        );
        assert!(
            result.message.contains("nested")
                && result
                    .message
                    .contains("All 1 path(s) promised for removal are gone."),
            "{}",
            result.message
        );
    }

    /// `reset` succeeded and `clean` did not, which is the case a single
    /// success-or-failure bool cannot carry: HEAD moved and nothing undoes that,
    /// while the file the preview promised is still on disk.
    #[cfg(unix)]
    #[test]
    fn a_restore_whose_clean_step_fails_says_which_of_the_two_ran() {
        use std::os::unix::fs::PermissionsExt;

        let (root, target) = restore_repo();
        let dir = root.path();
        write_at(
            dir,
            "locked/keep.txt",
            "untracked, behind a directory that will not open\n",
        );
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        assert_eq!(preview.removed, ["locked/keep.txt", "plain.txt"]);

        let locked = dir.join("locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = restore_clean(&writes, &sessions, preview.nonce).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(result.outcome, Outcome::Partial, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), target, "the reset ran");
        assert!(!dir.join("plain.txt").exists(), "the removal started");
        assert!(
            dir.join("locked/keep.txt").exists(),
            "and did not finish with this path"
        );
        assert!(
            result.message.contains("The working copy reached")
                && result.message.contains("were not all removed")
                && result
                    .message
                    .contains("1 of the 2 path(s) promised for removal are not."),
            "{}",
            result.message
        );
    }

    /// The two conditions answer different questions and can point opposite
    /// ways: the comparison against the target is silent about an untracked file,
    /// and the working copy can be perfectly clean against a commit it was never
    /// restored to. Neither one alone is the answer to "is it clean now".
    #[test]
    fn the_aftermath_answers_the_two_conditions_apart() {
        let (root, target) = restore_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let work_root = sessions.commit_context(version).unwrap().0;
        let stepped_over = head(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        let result = restore_clean(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);

        let cancelled = AtomicBool::new(false);
        let settled = read_aftermath(&sessions, &work_root, &cancelled, &target);
        assert!(settled.clean(), "{}", settled.sentence(&[]));

        write_at(dir, "late.txt", "written after the restore\n");
        let left = read_aftermath(&sessions, &work_root, &cancelled, &target);
        assert!(!left.clean());
        assert_eq!(left.matches_target, Some(true), "diff is silent about it");
        assert_eq!(names(&left.leftovers), ["late.txt"]);
        assert!(
            left.sentence(&[b"late.txt".to_vec()])
                .contains("1 of the 1 path(s) promised for removal are not."),
            "{}",
            left.sentence(&[b"late.txt".to_vec()])
        );

        std::fs::remove_file(dir.join("late.txt")).unwrap();
        let apart = read_aftermath(&sessions, &work_root, &cancelled, &stepped_over);
        assert_eq!(apart.matches_target, Some(false));
        assert!(apart.leftovers.is_empty(), "the working copy is clean");
        assert!(
            apart
                .sentence(&[])
                .contains("the tracked content is not the target's"),
            "{}",
            apart.sentence(&[])
        );
    }

    /// A cancel that arrives before the ticket is confirmed stops both steps
    /// with one process unstarted: there is no half-run restore to report,
    /// because nothing ran.
    #[test]
    fn a_cancel_before_git_starts_leaves_a_restore_untouched() {
        let (root, target) = restore_repo();
        let dir = root.path();
        let before = head(dir);
        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        // Taking the slot clears the cancel flag, so the flag is set inside a
        // held operation — the only order a real cancellation can arrive in.
        writes.begin().unwrap();
        writes.cancel();
        let result = run_restore(&writes, &sessions, &preview.nonce).unwrap();
        writes.finish();

        assert_eq!(result.outcome, Outcome::Cancelled, "{}", result.message);
        assert!(
            result.message.contains("before Git ran"),
            "{}",
            result.message
        );
        assert_eq!(result.exit_code, None);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), before);
        assert!(dir.join("plain.txt").exists());
    }

    /// The second step is asked by a process of its own, and that process can
    /// fail to answer at all: a promised set whose listing no longer fits the
    /// capture is `clean_preview_failed`, not an empty list. Before this, the
    /// error left the operation as a command error — which reports nothing over
    /// a working copy whose head the first step had already moved. The reset is
    /// named as done, the removal as unfinished, and the tree is described by
    /// what Git says about it afterwards.
    #[test]
    fn a_removal_that_cannot_be_listed_reports_the_reset_that_already_ran() {
        let (root, target) = restore_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let work_root = sessions.commit_context(version).unwrap().0;
        let mut plan = plan_restore(&work_root, &sessions, &target).unwrap();
        let names = (0..1600)
            .map(|i| format!("untracked-bulk-file-number-{i:04}.txt"))
            .collect::<Vec<_>>();
        for name in &names {
            write_at(dir, name, "untracked\n");
        }
        plan.removals = names
            .iter()
            .map(|name| Untracked {
                raw: name.as_bytes().to_vec(),
                repository: false,
            })
            .collect();

        writes.begin().unwrap();
        let ran = run_restore_steps(&writes, &sessions, &work_root, &plan).unwrap();
        writes.finish();

        assert_eq!(ran.outcome, Outcome::Partial, "{}", ran.message);
        assert!(
            ran.message.contains("Restored the working copy")
                && ran.message.contains(
                    "The removal did not complete: git clean could not list the untracked files."
                ),
            "{}",
            ran.message
        );
        assert!(
            !ran.message.contains("is clean and matches the target"),
            "an unasked removal is never a clean restore: {}",
            ran.message
        );
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), target, "the reset ran");
        assert_eq!(
            std::fs::read_to_string(dir.join("keep.txt")).unwrap(),
            "the target's own bytes\n",
            "and its write stands"
        );
        assert!(dir.join("plain.txt").exists(), "nothing was removed");
    }

    /// The verdict rule, in the four shapes it has to answer for: a cancel the
    /// user asked for is still a cancel when the tree happens to look settled,
    /// and a step that did not succeed never becomes a clean restore because the
    /// two readings agree.
    #[test]
    fn only_a_finished_removal_and_a_settled_tree_are_a_clean_restore() {
        assert_eq!(restore_verdict(Outcome::Success, true), Outcome::Success);
        assert_eq!(restore_verdict(Outcome::Success, false), Outcome::Partial);
        assert_eq!(restore_verdict(Outcome::Failed, true), Outcome::Partial);
        assert_eq!(
            restore_verdict(Outcome::Cancelled, true),
            Outcome::Cancelled
        );
        assert_eq!(
            restore_verdict(Outcome::Cancelled, false),
            Outcome::Cancelled,
            "a cancel is not downgraded by a tree that looks clean"
        );
    }

    /// A cancel that lands on the removal stops a process that was started and
    /// never reported back. The first step is not undone by it, so the answer
    /// names the target the working copy reached and refuses to call the
    /// removal finished.
    #[test]
    fn a_cancel_on_the_removal_names_the_reset_it_follows() {
        let (root, target) = restore_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let work_root = sessions.commit_context(version).unwrap().0;
        let short_target = short(&target);
        let reset = write::Ran::ok(
            format!("Restored the working copy to {short_target}."),
            Some(0),
        );

        writes.begin().unwrap();
        writes.cancel();
        let ran = step_two(
            &writes,
            &work_root,
            &short_target,
            &reset,
            &[b"plain.txt".to_vec()],
        )
        .unwrap();
        writes.finish();

        assert_eq!(ran.outcome, Outcome::Cancelled, "{}", ran.message);
        assert!(
            ran.message.contains(&format!(
                "The working copy reached {short_target}; the untracked files were not all removed."
            )),
            "{}",
            ran.message
        );
        assert_eq!(ran.exit_code, None, "a killed process has no status");
    }

    /// A repository put where the target writes after the preview is refused by
    /// the same sentence the preview gave — and the refusal is the point,
    /// because the command it replaces destroys that repository silently.
    #[test]
    fn a_repository_put_in_the_way_after_the_preview_is_refused_at_the_gate() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        init(dir);
        write_at(dir, "keep.txt", "keep\n");
        write_at(dir, "y", "the target's own bytes\n");
        let target = commit_all(dir, "y is a file in the target");
        git(dir, &["rm", "-q", "--", "y"]);
        commit_all(dir, "y dropped from the tree");

        let (writes, sessions, version) = state_and_session(dir);
        let preview = preview_restore(&writes, &sessions, version, &target).unwrap();
        assert!(preview.overwritten.is_empty(), "nothing is in the way yet");
        repository_in(dir, "y");

        let result = restore_clean(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected, "{}", result.message);
        assert!(result.message.contains("`y`"), "{}", result.message);
        assert!(
            dir.join("y/own.txt").exists(),
            "the refusal is what kept a repository alive"
        );
    }
}
