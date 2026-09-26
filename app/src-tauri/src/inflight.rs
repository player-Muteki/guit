//! In-flight Git operation detection. The
//! snapshot must never present a repository as clean while Git holds an
//! unfinished merge/rebase/cherry-pick/revert, and the continue/abort
//! affordances may only be offered when the operation is positively
//! identified. Detection reads the *identity git dir* (so linked worktrees
//! get their own markers), treats each marker file as an expected commit
//! reference and demands a full object id; anything that cannot be
//! identified — an unparseable marker, two operations' markers side by
//! side, or status conflicts with no markers at all — reports `unknown`
//! with honest text rather than a guess or a clean report.

use crate::history;
use crate::probe::ProbeError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationKindView {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationView {
    pub kind: OperationKindView,
    pub subject: String,
    pub step: Option<u32>,
    pub total: Option<u32>,
}

fn read_error() -> ProbeError {
    ProbeError::new(
        "inflight_read_failed",
        "Git's in-progress operation state could not be read; refusing to report a clean repository.",
    )
}

fn unknown(subject: &str) -> Option<OperationView> {
    Some(OperationView {
        kind: OperationKindView::Unknown,
        subject: subject.to_owned(),
        step: None,
        total: None,
    })
}

const UNIDENTIFIED: &str =
    "An operation appears to be in progress but Git's state could not be identified.";

/// Returns None for absent files, Some(contents) for present ones, and a
/// structured error when a file exists but cannot be read (the plan's rule:
/// never present a read failure as a clean repository).
fn read_marker(git_dir: &Path, name: &str) -> Result<Option<String>, ProbeError> {
    match std::fs::read(git_dir.join(name)) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(read_error()),
    }
}

fn is_dir(git_dir: &Path, name: &str) -> bool {
    git_dir.join(name).is_dir()
}

/// A `*_HEAD` marker must contain a full object id on its first line.
fn marker_oid(raw: &str) -> Option<String> {
    let first = raw.lines().next().unwrap_or("").trim();
    history::valid_oid(first).then(|| first.to_owned())
}

fn rebase_progress(git_dir: &Path) -> Result<(Option<u32>, Option<u32>), ProbeError> {
    // `rebase-merge` (branch-based, incl. interactive) carries msgnum/end;
    // interactivity is deliberately disabled by guit, so both exist once
    // the sequence has started. `rebase-apply` (am/legacy) uses next/last.
    let (num_file, end_file) = if is_dir(git_dir, "rebase-merge") {
        ("rebase-merge/msgnum", "rebase-merge/end")
    } else {
        ("rebase-apply/next", "rebase-apply/last")
    };
    let number = |file: &str| -> Result<Option<u32>, ProbeError> {
        match read_marker(git_dir, file) {
            Ok(Some(raw)) => Ok(raw.trim().parse::<u32>().ok()),
            Ok(None) => Ok(None),
            Err(error) => Err(error),
        }
    };
    Ok((number(num_file)?, number(end_file)?))
}

fn rebase_subject(git_dir: &Path) -> Result<String, ProbeError> {
    // `rebase-merge/head-name` names the branch being rewritten; the
    // apply series has no such file, so fall back to generic text.
    match read_marker(git_dir, "rebase-merge/head-name")? {
        Some(raw) => {
            let name = raw.trim().strip_prefix("refs/heads/").unwrap_or("");
            if name.is_empty() || name.contains('\n') {
                Ok("Rebasing…".to_owned())
            } else {
                Ok(format!("Rebasing {name}"))
            }
        }
        None => Ok("Rebasing…".to_owned()),
    }
}

fn merge_subject(git_dir: &Path) -> Result<String, ProbeError> {
    match read_marker(git_dir, "MERGE_MSG")? {
        Some(raw) => {
            let first = raw
                .lines()
                .find(|line| !line.starts_with('#') && !line.trim().is_empty())
                .unwrap_or("")
                .trim();
            if first.is_empty() {
                Ok("Merging…".to_owned())
            } else {
                Ok(first.to_owned())
            }
        }
        None => Ok("Merging…".to_owned()),
    }
}

/// Marker-only detection over a repository's git dir. `has_conflicts` is
/// the caller's evidence of unmerged status entries (the status read that
/// produced it may be the snapshot's own); conflicts with no marker are
/// reported as `unknown` instead of a clean snapshot.
pub(crate) fn detect(
    git_dir: &Path,
    has_conflicts: bool,
) -> Result<Option<OperationView>, ProbeError> {
    let merge_head = read_marker(git_dir, "MERGE_HEAD")?;
    let pick_head = read_marker(git_dir, "CHERRY_PICK_HEAD")?;
    let revert_head = read_marker(git_dir, "REVERT_HEAD")?;
    let rebase_merge = is_dir(git_dir, "rebase-merge");
    let rebase_apply = !rebase_merge && is_dir(git_dir, "rebase-apply");

    let mut candidates: Vec<OperationView> = Vec::new();
    if let Some(raw) = &merge_head {
        if marker_oid(raw).is_some() {
            candidates.push(OperationView {
                kind: OperationKindView::Merge,
                subject: merge_subject(git_dir)?,
                step: None,
                total: None,
            });
        } else {
            return Ok(unknown(
                "A merge marker is unreadable; Git's state is ambiguous.",
            ));
        }
    }
    if rebase_merge || rebase_apply {
        let (step, total) = rebase_progress(git_dir)?;
        candidates.push(OperationView {
            kind: OperationKindView::Rebase,
            subject: rebase_subject(git_dir)?,
            step,
            total,
        });
    }
    for (raw, kind, verb) in [
        (
            pick_head.as_deref(),
            OperationKindView::CherryPick,
            "Cherry-picking",
        ),
        (
            revert_head.as_deref(),
            OperationKindView::Revert,
            "Reverting",
        ),
    ] {
        if let Some(raw) = raw {
            match marker_oid(raw) {
                Some(oid) => candidates.push(OperationView {
                    kind,
                    subject: format!("{verb} {oid}…"),
                    step: None,
                    total: None,
                }),
                None => {
                    return Ok(unknown(
                        "An operation marker is unreadable; Git's state is ambiguous.",
                    ))
                }
            }
        }
    }

    match candidates.len() {
        0 => Ok(has_conflicts.then(|| unknown(UNIDENTIFIED).expect("unknown is always Some"))),
        1 => Ok(candidates.pop()),
        // Multiple concurrent markers: refuse to pick one; report unknown so
        // the UI offers no continue/abort guess.
        _ => Ok(unknown(
            "Multiple operation markers are present; Git's state is ambiguous.",
        )),
    }
}

/// Convenience for write paths that only need "is something in progress"
/// and have no fresh status read at hand.
pub(crate) fn detect_from_identity(
    identity: &crate::repo::RepoIdentity,
) -> Result<Option<OperationView>, ProbeError> {
    detect(&identity.git_dir, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_dir_with(files: &[(&str, &str)], dirs: &[&str]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        for name in dirs {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        for (name, body) in files {
            std::fs::write(dir.join(name), body).unwrap();
        }
        root
    }

    const OID: &str = "0123456789abcdef0123456789abcdef01234567";
    const OID2: &str = "89abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn clean_git_dir_reports_no_operation() {
        let root = git_dir_with(&[], &[]);
        assert_eq!(detect(root.path(), false).unwrap(), None);
    }

    #[test]
    fn merge_marker_with_oid_and_message_is_identified() {
        let root = git_dir_with(
            &[
                ("MERGE_HEAD", &format!("{OID}\n")),
                ("MERGE_MSG", "Merge branch 'side'\n# Conflicts:\n#\ta.txt\n"),
            ],
            &[],
        );
        let view = detect(root.path(), false).unwrap().expect("merge");
        assert_eq!(view.kind, OperationKindView::Merge);
        assert_eq!(view.subject, "Merge branch 'side'");
        assert_eq!((view.step, view.total), (None, None));
    }

    #[test]
    fn conflicts_without_markers_report_unknown_not_clean() {
        let root = git_dir_with(&[], &[]);
        let view = detect(root.path(), true).unwrap().expect("unknown");
        assert_eq!(view.kind, OperationKindView::Unknown);
    }

    #[test]
    fn bad_oid_marker_reports_unknown_never_a_guess() {
        let root = git_dir_with(&[("MERGE_HEAD", "not-an-oid\n")], &[]);
        let view = detect(root.path(), false).unwrap().expect("unknown");
        assert_eq!(view.kind, OperationKindView::Unknown);
    }

    #[test]
    fn multiple_markers_report_unknown() {
        let root = git_dir_with(
            &[
                ("MERGE_HEAD", &format!("{OID}\n")),
                ("REVERT_HEAD", &format!("{OID2}\n")),
            ],
            &[],
        );
        let view = detect(root.path(), false).unwrap().expect("unknown");
        assert_eq!(view.kind, OperationKindView::Unknown);
        assert!(view.subject.contains("Multiple"));
    }

    #[test]
    fn rebase_merge_counts_steps_and_names_the_branch() {
        let root = git_dir_with(
            &[
                ("rebase-merge/head-name", "refs/heads/topic\n"),
                ("rebase-merge/msgnum", "2\n"),
                ("rebase-merge/end", "4\n"),
            ],
            &["rebase-merge"],
        );
        let view = detect(root.path(), false).unwrap().expect("rebase");
        assert_eq!(view.kind, OperationKindView::Rebase);
        assert_eq!(view.subject, "Rebasing topic");
        assert_eq!((view.step, view.total), (Some(2), Some(4)));
    }

    #[test]
    fn rebase_apply_series_is_also_recognised() {
        let root = git_dir_with(
            &[("rebase-apply/next", "1\n"), ("rebase-apply/last", "3\n")],
            &["rebase-apply"],
        );
        let view = detect(root.path(), false).unwrap().expect("rebase");
        assert_eq!(view.kind, OperationKindView::Rebase);
        assert_eq!((view.step, view.total), (Some(1), Some(3)));
    }

    #[test]
    fn cherry_pick_and_revert_markers_are_distinguished() {
        let pick = git_dir_with(&[("CHERRY_PICK_HEAD", &format!("{OID}\n"))], &[]);
        let view = detect(pick.path(), false).unwrap().expect("pick");
        assert_eq!(view.kind, OperationKindView::CherryPick);
        assert!(view.subject.contains(&OID[..8]));
        let revert = git_dir_with(&[("REVERT_HEAD", &format!("{OID}\n"))], &[]);
        assert_eq!(
            detect(revert.path(), false).unwrap().expect("revert").kind,
            OperationKindView::Revert
        );
    }
}
