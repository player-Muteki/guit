//! Tag create / view / delete. Names are validated by
//! the user's own Git through `check-ref-format refs/tags/<name>` — the
//! prefix guarantees a name can never be read as an option or land outside
//! refs/tags. Annotation text travels to Git in a 0600 temp file that is
//! deleted when Git exits and never appears in results or logs. Deletion
//! reuses the one-time preview ticket flow, bound to the object id observed
//! at preview time.

use crate::probe::{Code, ProbeError};
use crate::write::{self, OperationKind, OperationResult, Outcome, PreviewResult, WriteState};
use crate::{branches, history, refs, repo, runner, session};
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Rust-side guardrails before Git is consulted, mirroring the branch
/// precheck; a leading `refs/` is additionally rejected because a tag's
/// display name may not smuggle a second namespace into the ref path.
pub(crate) fn precheck_tag_name(name: &str) -> Result<(), ProbeError> {
    let unusable = name.is_empty()
        || name.len() > branches::MAX_NAME_LEN
        || name.starts_with('-')
        || name.starts_with("refs/")
        || name.contains("@{")
        || name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f);
    if unusable {
        return Err(ProbeError::new(
            "tag_name_invalid",
            "The tag name is not usable: no leading dashes or refs/, no @{...}, no control characters.",
        ));
    }
    Ok(())
}

/// The user's Git must accept the full ref name. Unlike `--branch` mode
/// there is no shorthand expansion (the ref name is passed verbatim), and
/// non-branch mode additionally rejects `~ ^ : ? * [ \ space`, empty and
/// dotted segments (measured on Git 2.53).
pub(crate) fn validate_tag_name(work_root: &Path, name: &str) -> Result<(), ProbeError> {
    precheck_tag_name(name)?;
    let full = format!("refs/tags/{name}");
    let output = branches::run_git(
        work_root,
        &["check-ref-format", &full],
        &AtomicBool::new(false),
    )?;
    if !output.status.success() {
        return Err(ProbeError::new(
            "tag_name_invalid",
            "Git rejected this tag name (check-ref-format).",
        ));
    }
    Ok(())
}

fn unique_tag<'a>(
    listing: &'a refs::RefListing,
    name: &str,
) -> Result<&'a refs::TagRef, ProbeError> {
    let mut matches = listing.tags.iter().filter(|t| t.name == name);
    let found = matches.next().ok_or_else(|| {
        ProbeError::new(
            "tag_missing",
            "That tag no longer exists in this repository.",
        )
    })?;
    if matches.next().is_some() {
        return Err(ProbeError::new(
            "tag_ambiguous",
            "Several tags display under this name; the request was refused.",
        ));
    }
    if !found.addressable {
        return Err(ProbeError::new(
            "tag_not_addressable",
            "That tag name is not byte-round-trippable; guit refuses to target it.",
        ));
    }
    Ok(found)
}

fn tag_exists(listing: &refs::RefListing, name: &str) -> bool {
    listing.tags.iter().any(|t| t.name == name)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDetail {
    pub name: String,
    pub oid: String,
    /// Commit the tag resolves to; equals `oid` for lightweight tags.
    pub target_oid: String,
    pub annotated: bool,
    /// Tag message — only an *annotated* tag has one. Git's `%(contents)`
    /// falls back to the *commit* message for lightweight tags (measured on
    /// Git 2.53), so text is taken only when the object type proves the tag
    /// object itself exists. Empty for lightweight tags.
    pub message: String,
}

/// Read-only annotation view for one exact, uniquely addressable tag. The
/// query names a single full ref, so record boundaries cannot shift and the
/// message (last field) may contain newlines freely.
pub(crate) fn tag_detail(directory: &Path, name: &str) -> Result<TagDetail, ProbeError> {
    precheck_tag_name(name)?;
    let listing = refs::list(directory)?;
    // The gate matters: missing, duplicated or non-round-trippable names
    // must not reach the annotation query below.
    unique_tag(&listing, name)?;
    let mut command = repo::user_git_command(directory);
    command.args([
        "for-each-ref",
        "--format=%(objecttype)%1f%(objectname)%1f%(*objectname)%1f%(contents)",
        &format!("refs/tags/{name}"),
    ]);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(10),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let first_line = detail.lines().next().unwrap_or("").to_owned();
        return Err(ProbeError::new("tag_detail_failed", first_line));
    }
    if output.truncated {
        return Err(ProbeError::new(
            "history_truncated",
            "The tag record exceeded the capture limit and was not parsed.",
        ));
    }
    let record = String::from_utf8_lossy(&output.stdout);
    let mut fields = record.splitn(4, '\x1f');
    let objecttype = fields.next().unwrap_or_default();
    let objectname = fields.next().unwrap_or_default().trim();
    let peeled = fields.next().unwrap_or_default().trim();
    let contents = fields.next().unwrap_or_default();
    if objectname.is_empty() {
        // Empty stdout means the ref vanished between listing and query;
        // anything shorter fails closed instead of guessing.
        return Err(ProbeError::new(
            "refs_protocol_error",
            "Git emitted a tag record without an object id; nothing was parsed.",
        ));
    }
    let annotated = objecttype.trim() == "tag";
    Ok(TagDetail {
        name: name.to_owned(),
        oid: objectname.to_owned(),
        target_oid: if peeled.is_empty() {
            objectname.to_owned()
        } else {
            peeled.to_owned()
        },
        annotated,
        message: if annotated {
            contents.to_owned()
        } else {
            String::new()
        },
    })
}

pub(crate) fn create_tag(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: &str,
    target_oid: Option<&str>,
    message: Option<&str>,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    // Blank annotation means a lightweight tag, not an empty -F file.
    let annotation = message.filter(|text| !text.trim().is_empty());
    let result = run_create(
        state,
        sessions,
        snapshot_version,
        name,
        target_oid,
        annotation,
    );
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_create(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: &str,
    target_oid: Option<&str>,
    annotation: Option<&str>,
) -> Result<OperationResult, ProbeError> {
    let kind = OperationKind::TagCreate;
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let mut message = String::new();
    let mut details = None;
    let mut prepared = None;
    match sessions.commit_context(snapshot_version) {
        Err(error) => {
            outcome = Outcome::Rejected;
            message = error.message;
        }
        Ok((work_root, _unborn)) => {
            if state.cancel_flag().load(Ordering::SeqCst) {
                outcome = Outcome::Cancelled;
                message = "Cancelled before Git ran.".into();
            } else {
                match prepare_create(&work_root, name, target_oid) {
                    Err(branches::PrepareError::Rejected(error)) => {
                        outcome = Outcome::Rejected;
                        message = error.message;
                    }
                    Err(branches::PrepareError::Failed(error)) => return Err(error),
                    Ok(()) => prepared = Some(work_root),
                }
            }
        }
    }
    if let Some(work_root) = prepared {
        // The 0600 temp file is created only after every gate passed and is
        // dropped below, before the post-operation re-read.
        let mut message_file: Option<tempfile::NamedTempFile> = None;
        let mut command = repo::user_git_command(&work_root);
        command.arg("tag");
        let mut launch = true;
        if let Some(text) = annotation {
            command.arg("-a");
            match write_annotation(text) {
                Ok(file) => {
                    command.args(["-F"]);
                    command.arg(file.path());
                    message_file = Some(file);
                }
                Err(error) => {
                    outcome = Outcome::Failed;
                    message = "The annotation could not be staged for Git.".into();
                    // IO text never contains the annotation itself.
                    details = Some(error);
                    launch = false;
                }
            }
        }
        command.arg(name);
        if let Some(oid) = target_oid {
            command.arg(oid);
        }
        if launch {
            let run = runner::run_with_limit(
                command,
                state.cancel_flag(),
                Duration::ZERO,
                Duration::from_secs(60),
                runner::DEFAULT_OUTPUT_LIMIT,
                |_, _| {},
            );
            drop(message_file);
            match run {
                Ok(output) => {
                    exit_code = output.status.code();
                    if output.status.success() && !output.truncated {
                        message = "Tag created.".into();
                    } else {
                        outcome = Outcome::Failed;
                        message = "tag reported a failure.".into();
                        details = Some(crate::write::first_stderr_line(&output.stderr));
                    }
                }
                Err(error) if error.code == Code::PROCESS_CANCELLED => {
                    outcome = Outcome::Cancelled;
                    message = "Cancelled while the Git process was running.".into();
                }
                Err(error) => return Err(error),
            }
        }
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        category: None,
        suggestion: None,
        operation_id: 0,
        kind,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

/// Writes the annotation to a fresh 0600 temp file (NamedTempFile's default
/// permissions), synced before Git may see it. Errors are returned as plain
/// IO text — never the annotation.
fn write_annotation(text: &str) -> Result<tempfile::NamedTempFile, String> {
    let file = tempfile::NamedTempFile::new().map_err(|error| error.to_string())?;
    let mut written = file.reopen().map_err(|error| error.to_string())?;
    written
        .write_all(text.as_bytes())
        .and_then(|_| written.write_all(b"\n"))
        .and_then(|_| written.sync_all())
        .map_err(|error| error.to_string())?;
    drop(written);
    Ok(file)
}

/// Everything that must hold before a tag Git process may start: name
/// validation against the user's Git and a duplicate check against a
/// freshly re-listed ref catalog — never the client's view.
fn prepare_create(
    work_root: &Path,
    name: &str,
    target_oid: Option<&str>,
) -> Result<(), branches::PrepareError> {
    if let Err(error) = validate_tag_name(work_root, name) {
        return Err(if error.code == Code::TAG_NAME_INVALID {
            branches::PrepareError::Rejected(error)
        } else {
            branches::PrepareError::Failed(error)
        });
    }
    if target_oid.is_some_and(|oid| !history::valid_oid(oid)) {
        return Err(branches::PrepareError::Rejected(ProbeError::new(
            "tag_target_invalid",
            "The tag target must be a full commit id.",
        )));
    }
    let listing = refs::list(work_root).map_err(branches::PrepareError::Failed)?;
    if tag_exists(&listing, name) {
        return Err(branches::PrepareError::Rejected(ProbeError::new(
            "tag_exists",
            "A tag with that name already exists in this repository.",
        )));
    }
    Ok(())
}

pub(crate) fn preview_delete_tag(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: &str,
) -> Result<PreviewResult, ProbeError> {
    let (work_root, _) = sessions.commit_context(snapshot_version)?;
    precheck_tag_name(name)?;
    let listing = refs::list(&work_root)?;
    let tag = unique_tag(&listing, name)?;
    let nonce = state.stage_ref_delete(
        write::RefTarget::Tag,
        work_root,
        name.to_owned(),
        tag.oid.clone(),
        false,
    );
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    Ok(PreviewResult {
        nonce,
        candidates: vec![name.to_owned()],
        dropped: Vec::new(),
        snapshot,
        target_oid: Some(tag.oid.clone()),
    })
}

pub(crate) fn delete_tag(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_delete(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Tag deletion has no force stage: `git tag -d` always removes the name,
/// so the guards are the consumed ticket, the unchanged session, and the
/// object id re-compared against the preview.
fn run_delete(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    write::confirm(
        state,
        sessions,
        OperationKind::TagDelete,
        nonce,
        write::Refusals {
            expired: "That confirmation has expired; preview the deletion again.",
            session_changed:
                "The repository session changed after the preview; no tag was deleted.",
            cancelled_before_git: "Cancelled before Git ran.",
        },
        |preview| match preview.bound {
            write::Bound::RefDelete {
                target: write::RefTarget::Tag,
                name,
                oid,
                ..
            } => Some((preview.work_root, (name, oid))),
            _ => None,
        },
        |work_root, (name, oid)| {
            let listing = refs::list(work_root)?;
            let unchanged = match unique_tag(&listing, name) {
                Ok(tag) => tag.oid == *oid,
                Err(_) => false,
            };
            Ok(if unchanged {
                Ok(())
            } else {
                Err(
                    "The tag changed after the preview; nothing was deleted. Confirm again."
                        .to_owned(),
                )
            })
        },
        |work_root, (name, _)| {
            write::ran_from(
                branches::run_git(work_root, &["tag", "-d", name], state.cancel_flag()),
                write::Wording {
                    ok: "Tag deleted.".to_owned(),
                    failed: "tag reported a failure.".to_owned(),
                    cancelled: "Cancelled while the Git process was running.".to_owned(),
                },
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            args,
        );
    }

    fn head(dir: &Path) -> String {
        let output = std::process::Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "HEAD"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "--", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "base"]);
        root
    }

    fn tag_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = refs::list(dir)
            .unwrap()
            .tags
            .iter()
            .map(|t| t.name.clone())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn lightweight_and_annotated_tags_stay_distinguishable() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        let lite = create_tag(&writes, &sessions, view.version, "lite", None, None).unwrap();
        assert_eq!(lite.outcome, Outcome::Success);
        assert_eq!(lite.operation_id, 1);
        let version = lite.snapshot.expect("re-read").version;
        let annotated = create_tag(
            &writes,
            &sessions,
            version,
            "ann",
            None,
            Some("first line\nsecond line\nthird"),
        )
        .unwrap();
        assert_eq!(annotated.outcome, Outcome::Success);
        assert_eq!(tag_names(dir), vec!["ann", "lite"]);

        // The listing classifies by object type: a lightweight tag points at
        // the commit itself, an annotated one peels to it from a tag object.
        let listing = refs::list(dir).unwrap();
        let base = head(dir);
        let lite_ref = listing.tags.iter().find(|t| t.name == "lite").unwrap();
        assert!(!lite_ref.annotated);
        assert_eq!(lite_ref.oid, base);
        assert_eq!(lite_ref.target_oid, None);
        let ann_ref = listing.tags.iter().find(|t| t.name == "ann").unwrap();
        assert!(ann_ref.annotated);
        assert_ne!(ann_ref.oid, base);
        assert_eq!(ann_ref.target_oid.as_deref(), Some(base.as_str()));

        let lite_detail = tag_detail(dir, "lite").unwrap();
        assert!(!lite_detail.annotated);
        // Regression pin: Git's %(contents) answers a lightweight tag with
        // the *commit* message; guit must report no annotation instead.
        assert_eq!(lite_detail.message, "");
        let ann_detail = tag_detail(dir, "ann").unwrap();
        assert!(ann_detail.annotated);
        assert_eq!(ann_detail.oid, ann_ref.oid);
        assert_eq!(ann_detail.target_oid, base);
        assert_eq!(ann_detail.message.trim(), "first line\nsecond line\nthird");
    }

    #[test]
    fn unsafe_names_are_refused_before_any_tag_write() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        // Precheck rejections and names the user's own Git refuses through
        // check-ref-format (non-branch mode) — none may reach `git tag`.
        for bad in [
            "",
            "-a",
            "refs/tags/sneak",
            "x@{yesterday}",
            "new\nline",
            &"t".repeat(branches::MAX_NAME_LEN + 1),
            "sp ace",
            "tilde~name",
            "caret^n",
            "co:lon",
            "dot..start",
            "trail/",
        ] {
            let result = create_tag(&writes, &sessions, view.version, bad, None, None).unwrap();
            assert_eq!(result.outcome, Outcome::Rejected, "{bad:?} was accepted");
            assert!(result.exit_code.is_none(), "{bad:?} reached git tag");
        }
        assert!(tag_names(dir).is_empty());
    }

    #[test]
    fn stale_duplicate_and_bad_targets_are_guarded() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        // Every outcome re-reads and bumps the version, so calls chain.
        let stale = create_tag(&writes, &sessions, view.version + 1, "v1", None, None).unwrap();
        assert_eq!(stale.outcome, Outcome::Rejected);
        assert!(stale.message.contains("rejected"));

        let version = stale.snapshot.expect("re-read on rejection").version;
        let created = create_tag(&writes, &sessions, version, "v1", None, None).unwrap();
        assert_eq!(created.outcome, Outcome::Success);
        let version = created.snapshot.expect("re-read").version;
        let duplicate = create_tag(&writes, &sessions, version, "v1", None, None).unwrap();
        assert_eq!(duplicate.outcome, Outcome::Rejected);
        assert!(duplicate.message.contains("already exists"));

        let version = duplicate.snapshot.expect("re-read").version;
        let shorthand =
            create_tag(&writes, &sessions, version, "v2", Some("HEAD~1"), None).unwrap();
        assert_eq!(shorthand.outcome, Outcome::Rejected);
        assert!(shorthand.message.contains("full commit id"));

        // A well-formed but absent object id fails inside Git — Failed, not
        // Rejected — with the redacted refusal kept as details.
        let ghost = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let version = shorthand.snapshot.expect("re-read").version;
        let missing = create_tag(&writes, &sessions, version, "v2", Some(ghost), None).unwrap();
        assert_eq!(missing.outcome, Outcome::Failed);
        assert!(missing.details.is_some());
        assert_eq!(tag_names(dir), vec!["v1"]);
    }

    #[test]
    fn annotation_text_never_appears_in_the_result() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        let result = create_tag(
            &writes,
            &sessions,
            view.version,
            "secret",
            None,
            Some("TOPSECRET annotation body"),
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("TOPSECRET"), "annotation leaked into result");
        // And the tag really carries it (readable only through tag_detail).
        assert_eq!(
            tag_detail(dir, "secret").unwrap().message.trim(),
            "TOPSECRET annotation body"
        );
    }

    #[test]
    fn tag_on_unborn_head_fails_with_kept_details() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        let result = create_tag(&writes, &sessions, view.version, "v1", None, None).unwrap();
        assert_eq!(result.outcome, Outcome::Failed);
        assert_eq!(result.exit_code, Some(128));
        assert!(result.details.is_some());
        assert!(result.snapshot.is_some(), "state re-read after failure");
        assert!(tag_names(dir).is_empty());
    }

    #[test]
    fn delete_follows_preview_recheck_and_the_ticket_is_single_use() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        let missing = preview_delete_tag(&writes, &sessions, view.version, "ghost");
        assert_eq!(missing.unwrap_err().code.as_str(), "tag_missing");

        let created = create_tag(&writes, &sessions, view.version, "lite", None, None).unwrap();
        let snapshot = created.snapshot.expect("re-read");
        let preview = preview_delete_tag(&writes, &sessions, snapshot.version, "lite").unwrap();
        assert_eq!(preview.candidates, vec!["lite".to_owned()]);
        assert_eq!(preview.target_oid.as_deref(), Some(head(dir)).as_deref());

        // The tag is re-pointed after the preview → the ticket refuses and
        // the tag (at its new commit) survives untouched.
        git(dir, &["commit", "-q", "--allow-empty", "-m", "second"]);
        git(dir, &["tag", "-f", "lite"]);
        let drifted = delete_tag(&writes, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(drifted.outcome, Outcome::Rejected);
        assert!(drifted.message.contains("after the preview"));
        assert_eq!(tag_names(dir), vec!["lite"]);
        // The nonce was consumed by the refusal — replays expire too.
        let replay = delete_tag(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));

        // A fresh preview against the current state deletes successfully.
        let snapshot = replay.snapshot.expect("re-read on expiry");
        let preview = preview_delete_tag(&writes, &sessions, snapshot.version, "lite").unwrap();
        let deleted = delete_tag(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(deleted.outcome, Outcome::Success);
        assert_eq!(deleted.message, "Tag deleted.");
        assert!(tag_names(dir).is_empty());
    }

    #[test]
    fn a_branch_ticket_cannot_authorize_a_tag_delete() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        let created =
            branches::create_branch(&writes, &sessions, view.version, "side", None).unwrap();
        let snapshot = created.snapshot.expect("re-read");
        let branch_preview =
            branches::preview_delete_branch(&writes, &sessions, snapshot.version, "side", false)
                .unwrap();
        // Same ticket map, wrong kind: the tag runner refuses, and because a
        // take is consumed even on a kind mismatch (fail-closed) the branch
        // ticket is gone too — both sides must re-preview.
        let wrong_kind = delete_tag(&writes, &sessions, branch_preview.nonce.clone()).unwrap();
        assert_eq!(wrong_kind.outcome, Outcome::Rejected);
        assert!(wrong_kind.message.contains("expired"));
        let branch_ticket_gone = writes.take_bound(&branch_preview.nonce).is_none();
        assert!(branch_ticket_gone);
        let still_there = branches::preview_delete_branch(
            &writes,
            &sessions,
            wrong_kind.snapshot.unwrap().version,
            "side",
            false,
        )
        .unwrap();
        assert_eq!(still_there.candidates, vec!["side".to_owned()]);
    }

    #[test]
    fn cancelled_create_never_reaches_git_and_still_refreshes() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        // Hold the slot with cancellation armed, like cancel_write would.
        writes.begin().unwrap();
        writes.cancel();
        let result = run_create(
            &writes,
            &sessions,
            view.version,
            "v1",
            None,
            Some("some annotation"),
        )
        .unwrap();
        writes.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert!(result.exit_code.is_none());
        assert!(result.snapshot.is_some());
        assert!(tag_names(dir).is_empty());
    }
}
