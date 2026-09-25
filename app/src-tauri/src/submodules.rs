//! Submodule status and init/update (plan/04 写入动作规则, M4-07). The index
//! is the authoritative list: mode-160000 records from
//! `git ls-files --stage -z` give each entry's raw path and recorded commit
//! without any quoting ambiguity. Per-entry state is then verified with one
//! `git submodule status -- ":(literal)<path>"` run; the returned line must
//! prefix-match the raw index path or the whole listing is a protocol
//! error — never a guess. Per-path calls (measured, Git 2.53) also keep the
//! listing alive when some other entry lacks its `.gitmodules` mapping,
//! which makes a bulk `git submodule status` die with rc=128 before
//! reporting anything.
//!
//! The frontend addresses entries by their list position (`u32`) only; raw
//! paths are reconstructed backend-side from a fresh index read and travel
//! as one argv element behind `--`, never through a shell. Update never
//! deletes anything (`--init` registers and clones; the checkout refuses
//! when a submodule work tree is dirty), so it rides the ordinary write
//! lane with the external-tool timeout budget and streamed, redacted
//! progress lines. The file-transport restriction stays the user's Git
//! configuration call; guit does not inject `-c` overrides.

use crate::probe::{redact, ProbeError};
use crate::repo::{self, RepoIdentity};
use crate::runner::{self, DEFAULT_OUTPUT_LIMIT};
use crate::write::{self, OperationKind, OperationResult, Outcome, WriteState};
use crate::{history, session};
use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Read-only listing helpers never participate in write cancellation; they
/// run against this permanently-unset flag, mirroring the worktree module.
static NO_CANCEL: AtomicBool = AtomicBool::new(false);

/// Streaming clones can take far longer than any other write; the external
/// tool budget (3600 s) applies, with Stop covering the gap.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(3600);
const UPDATE_OUTPUT_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleState {
    /// Checked out at the commit the parent index records.
    UpToDate,
    /// Git's `-` flag: the entry has no repository checked out yet.
    Uninitialized,
    /// Git's `+` flag: the checked-out commit differs from the index.
    OutOfSync,
    /// A `U` flag, or gitlink stages left unmerged in the index.
    Conflicted,
    /// Git refuses state reporting because `.gitmodules` has no mapping
    /// for this path; the entry is listed anyway, never hidden.
    Unmapped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleView {
    pub index: u32,
    /// Repository-relative path, lossy display text; the backend
    /// reconstructs the raw bytes from the index for every operation.
    pub path: String,
    pub name: Option<String>,
    /// Credentials inside the url are redacted before serialization.
    pub url: Option<String>,
    /// The commit recorded in the parent index (authoritative).
    pub recorded_oid: String,
    /// The commit Git reports the submodule work tree holds; for `-` and
    /// `+` lines this is the index or checked-out oid respectively.
    pub checked_out_oid: Option<String>,
    pub state: SubmoduleState,
}

fn protocol_error(detail: &str) -> ProbeError {
    ProbeError::new(
        "submodules_protocol_error",
        format!(
            "The submodule listing did not match Git's expected format ({detail}); refusing to guess."
        ),
    )
}

fn session_directory(sessions: &session::SessionState) -> Result<PathBuf, ProbeError> {
    let identity = sessions
        .current_identity()
        .ok_or_else(|| ProbeError::new("submodules_no_session", "No repository is open."))?;
    bare_or_work_dir(&identity)
}

/// Read-only listings resolve in a bare repository from its git dir, like
/// the worktree list does; Git's own work-tree requirements then surface
/// as honest failures.
fn bare_or_work_dir(identity: &RepoIdentity) -> Result<PathBuf, ProbeError> {
    if identity.is_bare {
        Ok(identity.git_dir.clone())
    } else {
        identity
            .work_dir()
            .map(Path::to_path_buf)
            .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))
    }
}

fn run_git_os(dir: &Path, args: &[&OsStr]) -> Result<runner::CapturedOutput, ProbeError> {
    let mut command = repo::user_git_command(dir);
    command.args(args);
    runner::run_with_limit(
        command,
        &NO_CANCEL,
        Duration::ZERO,
        Duration::from_secs(60),
        DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )
}

fn literal_pathspec(raw_path: &[u8]) -> Result<OsString, ProbeError> {
    let mut spec = b":(literal)".to_vec();
    spec.extend_from_slice(raw_path);
    write::raw_to_os(&spec)
}

struct Gitlink {
    raw_path: Vec<u8>,
    oid: String,
    conflicted: bool,
}

/// One NUL-delimited `ls-files --stage` record: `<mode> <oid> <stage>\t<path>`.
/// Non-gitlink modes are skipped; any malformed gitlink record aborts the
/// whole listing.
fn parse_ls_files_record(record: &[u8]) -> Result<Option<Gitlink>, ProbeError> {
    let tab = record
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| protocol_error("record without tab"))?;
    let mut fields = record[..tab].split(|byte| *byte == b' ');
    let Some(mode) = fields.next() else {
        return Err(protocol_error("record without fields"));
    };
    if mode != b"160000" {
        return Ok(None);
    }
    let oid = fields
        .next()
        .ok_or_else(|| protocol_error("gitlink without oid"))?;
    let oid =
        String::from_utf8(oid.to_vec()).map_err(|_| protocol_error("gitlink oid is not utf-8"))?;
    if !history::valid_oid(&oid) {
        return Err(protocol_error("gitlink oid is not a full hex id"));
    }
    let stage = fields
        .next()
        .ok_or_else(|| protocol_error("gitlink without stage"))?;
    let stage: u8 = std::str::from_utf8(stage)
        .map_err(|_| protocol_error("stage is not utf-8"))?
        .parse()
        .map_err(|_| protocol_error("stage is not a number"))?;
    if fields.next().is_some() || record[tab + 1..].is_empty() {
        return Err(protocol_error("malformed gitlink record"));
    }
    Ok(Some(Gitlink {
        raw_path: record[tab + 1..].to_vec(),
        oid,
        conflicted: stage != 0,
    }))
}

/// Unmerged index entries repeat a path at several stages; they collapse
/// into one view whose conflicted flag says as much.
fn parse_ls_files(stdout: &[u8]) -> Result<Vec<Gitlink>, ProbeError> {
    let mut links: Vec<Gitlink> = Vec::new();
    for record in stdout.split(|byte| *byte == b'\0') {
        if record.is_empty() {
            continue; // trailing separator
        }
        let Some(link) = parse_ls_files_record(record)? else {
            continue;
        };
        match links.iter_mut().find(|seen| seen.raw_path == link.raw_path) {
            Some(existing) => existing.conflicted |= link.conflicted,
            None => links.push(link),
        }
    }
    Ok(links)
}

/// `<flag><oid> <path>[ (<describe>)]` for exactly one requested path.
/// The path tail must be empty or a `" ("` describe decoration — anything
/// else would mean the line is not about this entry, and guessing with it
/// is refused.
fn parse_status_line(line: &[u8], raw_path: &[u8]) -> Result<(SubmoduleState, String), ProbeError> {
    let line = match line.split_last() {
        Some((b'\r', head)) => head,
        _ => line,
    };
    let (state, rest) = match line.first() {
        Some(b' ') => (SubmoduleState::UpToDate, &line[1..]),
        Some(b'-') => (SubmoduleState::Uninitialized, &line[1..]),
        Some(b'+') => (SubmoduleState::OutOfSync, &line[1..]),
        Some(b'U') => (SubmoduleState::Conflicted, &line[1..]),
        _ => return Err(protocol_error("status flag outside ' ', '-', '+', 'U'")),
    };
    let space = rest
        .iter()
        .position(|byte| *byte == b' ')
        .ok_or_else(|| protocol_error("status line without oid separator"))?;
    let oid = String::from_utf8(rest[..space].to_vec())
        .map_err(|_| protocol_error("status oid is not utf-8"))?;
    if !history::valid_oid(&oid) {
        return Err(protocol_error("status oid is not a full hex id"));
    }
    let suffix = &rest[space + 1..];
    if !suffix.starts_with(raw_path) {
        return Err(protocol_error("status path does not match the index"));
    }
    let tail = &suffix[raw_path.len()..];
    if !tail.is_empty() && !tail.starts_with(b" (") {
        return Err(protocol_error("status path tail is ambiguous"));
    }
    Ok((state, oid))
}

struct Mapping {
    path: Vec<u8>,
    name: String,
    url: Option<String>,
}

/// `submodule.<name>.path` / `.url` from `git config -f .gitmodules --null
/// --get-regexp` (measured: records are `key\nvalue` separated by NUL, no
/// leading NUL; rc=1 with empty stdout means "no keys"). Keyed by path
/// bytes, which is what ties a section to an index gitlink; the section
/// name rides along for display only.
fn gitmodules_mappings(dir: &Path) -> Result<Vec<Mapping>, ProbeError> {
    if !dir.join(".gitmodules").exists() {
        return Ok(Vec::new());
    }
    let args: [&OsStr; 6] = [
        OsStr::new("config"),
        OsStr::new("-f"),
        OsStr::new(".gitmodules"),
        OsStr::new("--null"),
        OsStr::new("--get-regexp"),
        OsStr::new("^submodule\\."),
    ];
    let output = run_git_os(dir, &args)?;
    if !output.status.success() {
        if output.status.code() == Some(1) && output.stdout.is_empty() {
            return Ok(Vec::new());
        }
        return Err(ProbeError::new(
            "submodules_config_failed",
            format!(
                "Reading .gitmodules failed: {}",
                write::first_stderr_line(&output.stderr)
            ),
        ));
    }
    if output.truncated {
        return Err(ProbeError::new(
            "submodules_config_failed",
            "The .gitmodules listing exceeded the read limit.",
        ));
    }
    let mut names: Vec<String> = Vec::new();
    let mut records: Vec<(String, String, Vec<u8>)> = Vec::new();
    for record in output.stdout.split(|byte| *byte == b'\0') {
        if record.is_empty() {
            continue;
        }
        let Some(newline) = record.iter().position(|byte| *byte == b'\n') else {
            return Err(protocol_error("config record without a value"));
        };
        let key = std::str::from_utf8(&record[..newline])
            .map_err(|_| protocol_error("config key is not utf-8"))?;
        let middle = key
            .strip_prefix("submodule.")
            .ok_or_else(|| protocol_error("unexpected config key"))?;
        let Some((name, attribute)) = middle.rsplit_once('.') else {
            return Err(protocol_error("config key without attribute"));
        };
        if !names.iter().any(|seen| seen == name) {
            names.push(name.to_owned());
        }
        match attribute {
            "path" | "url" => {
                records.push((
                    name.to_owned(),
                    attribute.to_owned(),
                    record[newline + 1..].to_vec(),
                ));
            }
            _ => {} // branch and unknown attributes carry no display need
        }
    }
    let mut mappings = Vec::new();
    for (name, _, value) in records
        .iter()
        .filter(|(_, attribute, _)| attribute == "path")
    {
        let url = records
            .iter()
            .find(|(owner, attribute, _)| owner == name && attribute == "url")
            .map(|(_, _, url)| redact(&String::from_utf8_lossy(url)));
        mappings.push(Mapping {
            path: value.clone(),
            name: name.clone(),
            url,
        });
    }
    Ok(mappings)
}

/// One `git submodule status` call restricted to the literal index path
/// (measured, Git 2.53): another entry's missing mapping cannot take this
/// entry's answer down, and `:(literal)` disables globbing for names
/// containing `*?[`. Ok(None) is the honest unmapped state.
fn per_path_status(
    dir: &Path,
    raw_path: &[u8],
) -> Result<Option<(SubmoduleState, String)>, ProbeError> {
    let spec = literal_pathspec(raw_path)?;
    let head: [&OsStr; 3] = [
        OsStr::new("submodule"),
        OsStr::new("status"),
        OsStr::new("--"),
    ];
    let mut args: Vec<&OsStr> = head.to_vec();
    args.push(&spec);
    let output = run_git_os(dir, &args)?;
    if !output.status.success() {
        let refusal = write::first_stderr_line(&output.stderr);
        if refusal.contains("no submodule mapping found") {
            return Ok(None);
        }
        return Err(ProbeError::new(
            "submodules_status_failed",
            format!("git submodule status reported a failure: {refusal}"),
        ));
    }
    if output.truncated {
        return Err(ProbeError::new(
            "submodules_status_failed",
            "The submodule status output exceeded the read limit.",
        ));
    }
    let mut lines = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty());
    let line = lines
        .next()
        .ok_or_else(|| protocol_error("one requested path, no status line"))?;
    if lines.next().is_some() {
        return Err(protocol_error("one requested path, several status lines"));
    }
    parse_status_line(line, raw_path).map(Some)
}

fn gitlinks(dir: &Path) -> Result<Vec<Gitlink>, ProbeError> {
    let output = run_git_os(
        dir,
        &[
            OsStr::new("ls-files"),
            OsStr::new("--stage"),
            OsStr::new("-z"),
        ],
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "submodules_list_too_large",
            "The index listing exceeded the read limit.",
        ));
    }
    parse_ls_files(&output.stdout)
}

pub(crate) fn list_view(
    sessions: &session::SessionState,
) -> Result<Vec<SubmoduleView>, ProbeError> {
    let dir = session_directory(sessions)?;
    let links = gitlinks(&dir)?;
    let mappings = gitmodules_mappings(&dir)?;
    let mut views = Vec::new();
    for (position, link) in links.iter().enumerate() {
        let (state, checked_out) = if link.conflicted {
            (SubmoduleState::Conflicted, None)
        } else {
            match per_path_status(&dir, &link.raw_path)? {
                Some((state, oid)) => (state, Some(oid)),
                None => (SubmoduleState::Unmapped, None),
            }
        };
        let mapping = mappings.iter().find(|entry| entry.path == link.raw_path);
        views.push(SubmoduleView {
            index: position as u32,
            path: String::from_utf8_lossy(&link.raw_path).into_owned(),
            name: mapping.map(|entry| entry.name.clone()),
            url: mapping.and_then(|entry| entry.url.clone()),
            recorded_oid: link.oid.clone(),
            checked_out_oid: checked_out,
            state,
        });
    }
    Ok(views)
}

/// Streams complete redacted lines out of the interleaved byte chunks the
/// runner reports, mirroring the clone progress lane. Shared with the
/// network module's fetch streaming.
pub(crate) fn take_progress_bytes(
    buffer: &mut Vec<u8>,
    bytes: &[u8],
    on_line: &mut dyn FnMut(&str),
) {
    buffer.extend_from_slice(bytes);
    while let Some(position) = buffer
        .iter()
        .position(|byte| *byte == b'\n' || *byte == b'\r')
    {
        let line: Vec<u8> = buffer.drain(..=position).collect();
        emit_line(&line, on_line);
    }
}

pub(crate) fn emit_line(raw: &[u8], on_line: &mut dyn FnMut(&str)) {
    let text = String::from_utf8_lossy(raw);
    let line = text.trim_end_matches(['\r', '\n']).trim();
    if !line.is_empty() {
        on_line(&redact(line));
    }
}

/// Rebuilds the argv from a fresh index read: the position only selects a
/// path, the backend supplies the literal pathspec.
fn update_args(work_root: &Path, index: Option<u32>) -> Result<Vec<OsString>, String> {
    let mut args: Vec<OsString> = ["submodule", "update", "--init", "--recursive", "--progress"]
        .into_iter()
        .map(OsString::from)
        .collect();
    let Some(index) = index else {
        return Ok(args);
    };
    let links = gitlinks(work_root).map_err(|error| error.message)?;
    let link = links
        .into_iter()
        .nth(index as usize)
        .ok_or_else(|| "That submodule is no longer listed; refresh the view.".to_string())?;
    let spec = literal_pathspec(&link.raw_path).map_err(|_| {
        "The submodule path cannot be represented on this platform; the update was refused."
            .to_string()
    })?;
    args.push(OsString::from("--"));
    args.push(spec);
    Ok(args)
}

pub(crate) fn init_update(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    index: Option<u32>,
    on_line: &mut dyn FnMut(&str),
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_update(state, sessions, snapshot_version, index, on_line);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Assumes the queue slot is held; tests call this directly to pre-arm
/// cancellation, mirroring the other runners. Refusals carry
/// `exit_code: None`, proving Git never ran; every outcome ends in a forced
/// re-read. A cancelled or failed update may leave a partially cloned
/// entry behind — the message says so, because only the next honest list
/// can tell what survived.
fn run_update(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    index: Option<u32>,
    on_line: &mut dyn FnMut(&str),
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    let gates = match sessions.commit_context(snapshot_version) {
        Err(error) => Err(error.message),
        Ok((work_root, _unborn)) => match update_args(&work_root, index) {
            Err(refusal) => Err(refusal),
            Ok(args) => {
                if state.cancel_flag().load(Ordering::SeqCst) {
                    let snapshot = session::refresh(sessions)?;
                    return Ok(OperationResult {
                        category: None,
                        suggestion: None,
                        operation_id: 0,
                        kind: OperationKind::SubmoduleUpdate,
                        outcome: Outcome::Cancelled,
                        exit_code: None,
                        message: "Cancelled before Git ran; no submodule was touched.".into(),
                        details: None,
                        snapshot,
                    });
                }
                Ok((work_root, args))
            }
        },
    };
    match gates {
        Err(refusal) => {
            outcome = Outcome::Rejected;
            message = refusal;
        }
        Ok((work_root, args)) => {
            let mut command = repo::user_git_command(&work_root);
            command.args(&args);
            let mut buffer: Vec<u8> = Vec::new();
            let mut collect = |_: bool, bytes: &[u8]| {
                take_progress_bytes(&mut buffer, bytes, on_line);
            };
            let output = runner::run_with_limit(
                command,
                state.cancel_flag(),
                Duration::ZERO,
                UPDATE_TIMEOUT,
                UPDATE_OUTPUT_LIMIT,
                &mut collect,
            );
            if !buffer.is_empty() {
                let remainder = std::mem::take(&mut buffer);
                emit_line(&remainder, on_line);
            }
            match output {
                Ok(output) => {
                    exit_code = output.status.code();
                    if output.status.success() && !output.truncated {
                        message = match index {
                            None => "All listed submodules initialized and updated.".into(),
                            Some(_) => "Submodule initialized and updated.".into(),
                        };
                    } else {
                        outcome = Outcome::Failed;
                        message = if output.truncated {
                            "The update output exceeded the capture limit; the submodule state may be incomplete.".into()
                        } else {
                            "git submodule update reported a failure; the submodule state may be incomplete.".into()
                        };
                        details = Some(write::first_stderr_line(&output.stderr));
                    }
                }
                Err(error) if error.code == "process_cancelled" => {
                    outcome = Outcome::Cancelled;
                    message =
                        "Cancelled while Git ran; the submodule state may be incomplete.".into();
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
        kind: OperationKind::SubmoduleUpdate,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMIT_ID: &[&str] = &[
        "-c",
        "user.name=guit test",
        "-c",
        "user.email=test@example.invalid",
    ];

    fn git(dir: &Path, args: &[&str]) {
        repo::git_with(dir, COMMIT_ID, args);
    }

    fn head_oid(dir: &Path) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "HEAD"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn oid40(seed: u8) -> String {
        (0..40)
            .map(|i| format!("{:x}", (seed as usize + i) % 16))
            .collect()
    }

    /// Parent repo with one committed gitlink at `submodule_path`, left
    /// uninitialized: `git submodule add` clones (the fixture allows the
    /// file transport on its own command line — measured, Git 2.53 ignores
    /// `protocol.file.allow` set in local repo config as a security
    /// measure, and guit injects no `-c` overrides of its own), and
    /// `git submodule deinit --force` then empties the work tree while
    /// `.git/modules/<name>` keeps the objects, so a later update restores
    /// the checkout without any transport.
    fn parent_with_sub(submodule_path: &str) -> (tempfile::TempDir, tempfile::TempDir) {
        let child = tempfile::tempdir().unwrap();
        repo::git_with(
            child.path(),
            &[],
            &["init", "--quiet", "--initial-branch=main"],
        );
        std::fs::write(child.path().join("f.txt"), "one\n").unwrap();
        git(child.path(), &["add", "--", "f.txt"]);
        git(child.path(), &["commit", "-q", "-m", "first"]);
        let root = tempfile::tempdir().unwrap();
        repo::git_with(
            root.path(),
            &[],
            &["init", "--quiet", "--initial-branch=main"],
        );
        std::fs::write(root.path().join("a.txt"), "base\n").unwrap();
        git(root.path(), &["add", "--", "a.txt"]);
        git(root.path(), &["commit", "-q", "-m", "base"]);
        sub_add(root.path(), child.path().to_str().unwrap(), submodule_path);
        git(root.path(), &["commit", "-q", "-m", "add submodule"]);
        deinit_sub(root.path(), submodule_path);
        (root, child)
    }

    fn sub_add(root: &Path, url: &str, path: &str) {
        const FILE_ALLOW: &[&str] = &[
            "-c",
            "protocol.file.allow=always",
            "-c",
            "user.name=guit test",
            "-c",
            "user.email=test@example.invalid",
        ];
        repo::git_with(root, FILE_ALLOW, &["submodule", "add", "--", url, path]);
    }

    fn deinit_sub(root: &Path, path: &str) {
        repo::git_with(root, &[], &["submodule", "deinit", "--force", "--", path]);
    }

    fn sub_fetch(root: &Path) {
        repo::git_with(
            &root.join("sub"),
            &["-c", "protocol.file.allow=always"],
            &["fetch", "-q", "origin"],
        );
    }

    #[test]
    fn uninitialized_then_initialized_states_follow_the_real_git() {
        let (root, child) = parent_with_sub("sub");
        let child_oid = head_oid(child.path());
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root.path()).unwrap();

        let views = list_view(&sessions).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].state, SubmoduleState::Uninitialized);
        assert_eq!(views[0].name.as_deref(), Some("sub"));
        assert_eq!(views[0].recorded_oid, child_oid);
        assert_eq!(
            views[0].checked_out_oid.as_deref(),
            Some(child_oid.as_str())
        );
        assert_eq!(
            views[0].url.as_deref(),
            Some(child.path().to_str().unwrap())
        );

        let state = WriteState::default();
        let mut lines: Vec<String> = Vec::new();
        let result = init_update(&state, &sessions, view.version, None, &mut |line| {
            lines.push(line.to_owned())
        })
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{:?}", result.details);
        assert_eq!(
            result.snapshot.as_ref().unwrap().version,
            view.version + 1,
            "the forced re-read must bump the version"
        );
        assert!(root.path().join("sub").join("f.txt").exists());
        let views = list_view(&sessions).unwrap();
        assert_eq!(views[0].state, SubmoduleState::UpToDate);
        assert_eq!(
            views[0].checked_out_oid.as_deref(),
            Some(child_oid.as_str())
        );
    }

    #[test]
    fn out_of_sync_is_spotted_by_git_and_updated_back() {
        let (root, child) = parent_with_sub("sub");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root.path()).unwrap();
        let state = WriteState::default();
        init_update(&state, &sessions, view.version, None, &mut |_| {}).unwrap();

        // Advance the child, then move the submodule work tree to the new
        // commit and record it in the parent index: the checkout stays on
        // the old commit, so Git flags the entry with `+` naming the
        // checked-out oid, while the index records the new one.
        let old_oid = head_oid(child.path());
        std::fs::write(child.path().join("f.txt"), "two\n").unwrap();
        git(child.path(), &["add", "--", "f.txt"]);
        git(child.path(), &["commit", "-q", "-m", "second"]);
        let new_oid = head_oid(child.path());
        sub_fetch(root.path());
        git(root.path(), &["-C", "sub", "checkout", "-q", &new_oid]);
        git(root.path(), &["add", "sub"]);
        git(
            root.path(),
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-q",
                "-m",
                "bump sub",
            ],
        );
        // Move the submodule work tree back to the old commit: now the
        // index records new_oid while the checkout holds old_oid.
        git(root.path(), &["-C", "sub", "checkout", "-q", &old_oid]);
        let view = session::refresh(&sessions).unwrap().unwrap();
        let views = list_view(&sessions).unwrap();
        assert_eq!(views[0].state, SubmoduleState::OutOfSync);
        assert_eq!(views[0].recorded_oid, new_oid);
        assert_eq!(views[0].checked_out_oid.as_deref(), Some(old_oid.as_str()));

        let state = WriteState::default();
        let result = init_update(&state, &sessions, view.version, Some(0), &mut |_| {}).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{:?}", result.details);
        let views = list_view(&sessions).unwrap();
        assert_eq!(views[0].state, SubmoduleState::UpToDate);
        assert_eq!(views[0].checked_out_oid.as_deref(), Some(new_oid.as_str()));
    }

    #[test]
    fn literal_pathspec_survives_spaces_and_targets_one_entry() {
        let (root, child) = parent_with_sub("sp ace");
        sub_add(root.path(), child.path().to_str().unwrap(), "sub2");
        git(root.path(), &["commit", "-q", "-m", "add second"]);
        deinit_sub(root.path(), "sub2");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root.path()).unwrap();
        let views = list_view(&sessions).unwrap();
        assert_eq!(views.len(), 2);
        // Index order: "sp ace" sorts before "sub2" (space < '2').
        assert_eq!(views[0].path, "sp ace");
        assert_eq!(views[1].path, "sub2");
        assert_eq!(views[0].state, SubmoduleState::Uninitialized);

        let state = WriteState::default();
        let result = init_update(&state, &sessions, view.version, Some(0), &mut |_| {}).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{:?}", result.details);
        let views = list_view(&sessions).unwrap();
        assert_eq!(views[0].state, SubmoduleState::UpToDate);
        assert_eq!(views[1].state, SubmoduleState::Uninitialized);
    }

    #[test]
    fn unmapped_gitlink_is_listed_not_fatal_and_its_update_fails_honestly() {
        let (root, _child) = parent_with_sub("sub");
        // A raw gitlink staged without any .gitmodules mapping: measured to
        // make a bulk `git submodule status` die with rc=128; guit lists
        // both entries anyway, the ghost honestly flagged unmapped.
        let oid = head_oid(root.path());
        git(
            root.path(),
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{oid},ghostdir"),
            ],
        );
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root.path()).unwrap();
        let views = list_view(&sessions).unwrap();
        assert_eq!(views.len(), 2);
        let ghost = views
            .iter()
            .find(|entry| entry.path == "ghostdir")
            .expect("ghost entry listed");
        assert_eq!(ghost.state, SubmoduleState::Unmapped);
        assert_eq!(ghost.url, None);
        assert_eq!(ghost.name, None);
        assert_eq!(ghost.checked_out_oid, None);
        let sub = views.iter().find(|entry| entry.path == "sub").unwrap();
        assert_eq!(sub.state, SubmoduleState::Uninitialized);

        let state = WriteState::default();
        let result = init_update(
            &state,
            &sessions,
            view.version,
            Some(ghost.index),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Failed);
        // Git's own refusal, not a guit invention.
        assert!(result.details.is_some());
        assert!(result.snapshot.is_some());
    }

    #[test]
    fn parse_is_fail_closed_on_record_and_line_shapes() {
        let good = format!("160000 {} 0\tsub", oid40(1));
        assert!(parse_ls_files_record(good.as_bytes()).unwrap().is_some());
        assert!(parse_ls_files_record(b"100644 abc 0\tplain")
            .unwrap()
            .is_none());
        let bad: Vec<Vec<u8>> = vec![
            b"160000 nothex 0\tsub".into(),
            b"160000".into(),
            b"160000\tsub".into(),
            format!("160000 {} x\tsub", oid40(1)).into_bytes(),
            format!("160000 {} 0\t", oid40(1)).into_bytes(),
            format!("160000 {} 0 extra\tsub", oid40(1)).into_bytes(),
        ];
        for case in bad {
            assert!(
                parse_ls_files_record(&case).is_err(),
                "accepted {:?}",
                String::from_utf8_lossy(&case)
            );
        }

        let path = b"my dir";
        let (state, oid) = parse_status_line(
            format!(" {} my dir (heads/main)", oid40(1)).as_bytes(),
            path,
        )
        .unwrap();
        assert_eq!(state, SubmoduleState::UpToDate);
        assert_eq!(oid, oid40(1));
        let lines: Vec<String> = vec![
            format!("X{} my dir", oid40(1)),
            format!("-not-hex my dir"),
            format!("-{} mydir", oid40(1)),
            format!("-{} my dirx", oid40(1)),
            format!("-{} my  dir", oid40(1)),
            format!("-{}", oid40(1)),
        ];
        for line in lines {
            assert!(
                parse_status_line(line.as_bytes(), path).is_err(),
                "accepted {line:?}"
            );
        }
        let (state, oid) =
            parse_status_line(format!("+{} my dir\r", oid40(2)).as_bytes(), path).unwrap();
        assert_eq!(state, SubmoduleState::OutOfSync);
        assert_eq!(oid, oid40(2));
        assert_eq!(
            parse_status_line(format!("-{} my dir", oid40(3)).as_bytes(), path)
                .unwrap()
                .0,
            SubmoduleState::Uninitialized
        );
        assert_eq!(
            parse_status_line(format!("U{} my dir", oid40(4)).as_bytes(), path)
                .unwrap()
                .0,
            SubmoduleState::Conflicted
        );
    }

    #[test]
    fn stale_versions_missing_entries_and_cancellation_never_reach_git() {
        let (root, _child) = parent_with_sub("sub");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root.path()).unwrap();
        let state = WriteState::default();

        let result = init_update(&state, &sessions, view.version + 5, None, &mut |_| {}).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert_eq!(result.exit_code, None, "Git must not have run");
        // Every refusal still forces a re-read, so versions chain.
        let version = result.snapshot.unwrap().version;

        let result = init_update(&state, &sessions, version, Some(99), &mut |_| {}).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("no longer listed"));
        assert_eq!(result.exit_code, None);
        assert!(result.snapshot.is_some());
        let version = result.snapshot.unwrap().version;

        // A pre-armed cancellation short-circuits before the process runs,
        // yet the snapshot version still advances (inner path, slot held).
        let holder = state.begin().unwrap();
        state.cancel_flag().store(true, Ordering::SeqCst);
        let result = run_update(&state, &sessions, version, None, &mut |_| {}).unwrap();
        state.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert_eq!(result.exit_code, None);
        assert_eq!(
            result.operation_id, 0,
            "inner path leaves stamping to the wrapper"
        );
        let _ = holder;
        assert!(result.snapshot.unwrap().version > view.version);
        // Nothing was cloned: the submodule work tree is still absent.
        assert!(!root.path().join("sub").join(".git").exists());
    }

    #[test]
    fn progress_lines_are_redacted_and_reassembled() {
        let mut buffer = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        take_progress_bytes(&mut buffer, b"Cloning into 'https://us", &mut |line| {
            lines.push(line.to_owned())
        });
        assert!(lines.is_empty(), "partial lines must not be emitted");
        take_progress_bytes(
            &mut buffer,
            b"er:SEKRIT@example.com/x'\rReceiving objects: 100%",
            &mut |line| lines.push(line.to_owned()),
        );
        assert_eq!(lines.len(), 1);
        assert!(!lines[0].contains("SEKRIT"), "{}", lines[0]);
        take_progress_bytes(&mut buffer, b" done\nReceiving: 50%", &mut |line| {
            lines.push(line.to_owned())
        });
        assert_eq!(lines.len(), 2);
        assert!(!buffer.is_empty(), "trailing text stays buffered");
        let remainder = std::mem::take(&mut buffer);
        emit_line(&remainder, &mut |line| lines.push(line.to_owned()));
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn empty_index_is_not_an_error_and_reads_require_a_session() {
        let root = tempfile::tempdir().unwrap();
        repo::git_with(
            root.path(),
            &[],
            &["init", "--quiet", "--initial-branch=main"],
        );
        let sessions = session::SessionState::default();
        assert_eq!(
            list_view(&sessions).unwrap_err().code,
            "submodules_no_session"
        );
        session::open(&sessions, root.path()).unwrap();
        assert!(list_view(&sessions).unwrap().is_empty());
    }
}
