use crate::probe::{redact, ProbeError};
use crate::repo::{self, user_git_command};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// One clone may run at a time; cancellation is requested through the same
/// flag the process runner polls.
#[derive(Default)]
pub struct CloneState {
    pub cancelled: AtomicBool,
    pub running: AtomicBool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub target: String,
    pub success: bool,
    pub cancelled: bool,
    pub message: String,
    /// Heuristic cause of a Git-level clone failure; `None` on
    /// success, cancellation or a local protocol problem.
    pub category: Option<crate::netclassify::NetCategory>,
    /// Fixed advice text paired with `category`.
    pub suggestion: Option<String>,
    /// Folder left behind by a failed or interrupted clone. guit reports it
    /// but never deletes anything.
    pub residue: Option<String>,
}

/// Derives the clone folder name from a source URL or path, mirroring what
/// Git itself would choose, but never returning an empty or traversal name.
pub fn suggested_dir_name(source: &str) -> String {
    let trimmed = source.trim().trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', ':']).next().unwrap_or("");
    let cleaned: String = last
        .strip_suffix(".git")
        .unwrap_or(last)
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(['-', '.']).to_owned();
    if cleaned.is_empty() {
        "repository".to_owned()
    } else {
        cleaned
    }
}

/// The target only counts as residue when Git left real content behind.
fn residue_of(target: &Path) -> Option<String> {
    if !target.exists() {
        return None;
    }
    let occupied = target
        .is_dir()
        .then(|| {
            std::fs::read_dir(target)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(true)
        })
        .unwrap_or(true);
    occupied.then(|| repo::to_display(target))
}

/// Runs `git clone --progress` in `parent`, streaming stderr line by line
/// through `on_line`. Whatever the outcome, the actual filesystem state is
/// re-read before it is reported.
pub fn clone_repository(
    state: &CloneState,
    source: &str,
    parent: &Path,
    on_line: &mut dyn FnMut(&str),
) -> Result<CloneResult, ProbeError> {
    let source = source.trim();
    if source.is_empty() {
        return Err(ProbeError::new(
            "clone_source_missing",
            "Enter a repository URL or path to clone.",
        ));
    }
    if !parent.is_dir() {
        return Err(ProbeError::new(
            "clone_parent_missing",
            "Choose an existing folder to clone into.",
        ));
    }
    let name = suggested_dir_name(source);
    let target = parent.join(&name);
    if let Some(residue) = residue_of(&target) {
        return Err(ProbeError::new(
            "clone_target_occupied",
            format!("The target folder already exists and is not empty: {residue}"),
        ));
    }
    let mut command = user_git_command(parent);
    command.args(["clone", "--progress", "--", source, &name]);
    let mut buffer: Vec<u8> = Vec::new();
    let mut emit_lines = |is_stderr: bool, bytes: &[u8]| {
        if !is_stderr {
            return;
        }
        buffer.extend_from_slice(bytes);
        while let Some(position) = buffer.iter().position(|b| *b == b'\n' || *b == b'\r') {
            let line: Vec<u8> = buffer.drain(..=position).collect();
            emit_line(&line, on_line);
        }
    };
    let output = crate::runner::run_with_limit(
        command,
        &state.cancelled,
        Duration::ZERO,
        Duration::MAX,
        256 * 1024,
        &mut emit_lines,
    );
    if !buffer.is_empty() {
        let remainder = std::mem::take(&mut buffer);
        emit_line(&remainder, on_line);
    }
    let display_target = repo::to_display(&target);
    let (success, cancelled, message, category) = match output {
        Ok(output) => {
            if output.status.success() && !output.truncated {
                match repo::detect(&target) {
                    Ok(_) => (
                        true,
                        false,
                        "Clone completed and the new repository was detected.".to_owned(),
                        None,
                    ),
                    Err(error) => (
                        false,
                        false,
                        format!(
                            "Git reported success but no repository was detected: {}",
                            error.message
                        ),
                        None,
                    ),
                }
            } else {
                // A clone is a network operation even when the source is
                // local; the failure classifier gives the honest suggestion.
                let detail = last_error_line(&output.stderr);
                (
                    false,
                    false,
                    match detail {
                        Some(line) => format!("Git clone failed: {line}"),
                        None => "Git clone failed.".to_owned(),
                    },
                    Some(crate::netclassify::classify(&output.stderr)),
                )
            }
        }
        Err(error) if error.code == "process_cancelled" => {
            (false, true, "Clone cancelled.".to_owned(), None)
        }
        Err(error) => return Err(error),
    };
    Ok(CloneResult {
        target: display_target,
        success,
        cancelled,
        message,
        suggestion: category.map(|category| category.suggestion().to_owned()),
        category,
        residue: if success { None } else { residue_of(&target) },
    })
}

fn emit_line(raw: &[u8], on_line: &mut dyn FnMut(&str)) {
    let text = String::from_utf8_lossy(raw);
    let line = text.trim_end_matches(['\r', '\n']).trim();
    if !line.is_empty() {
        on_line(&redact(line));
    }
}

fn last_error_line(stderr: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stderr)
        .lines()
        .rev()
        .flat_map(|line| line.rsplit('\r'))
        .map(|part| part.trim_end())
        .find(|part| !part.is_empty())
        .map(|part| redact(part))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::git_with;
    use std::sync::atomic::Ordering;

    #[test]
    fn suggested_names_cover_common_source_shapes() {
        assert_eq!(
            suggested_dir_name("https://example.com/org/repo.git"),
            "repo"
        );
        assert_eq!(suggested_dir_name("git@github.com:org/my-app"), "my-app");
        assert_eq!(suggested_dir_name("/home/user/projects/tool/"), "tool");
        assert_eq!(suggested_dir_name("https://example.com/x/../y"), "y");
        assert_eq!(suggested_dir_name("https://example.com/a b*c"), "a-b-c");
        assert_eq!(suggested_dir_name("https://example.com/.."), "repository");
        assert_eq!(suggested_dir_name(""), "repository");
    }

    fn make_source(parent: &Path) -> std::path::PathBuf {
        let source = parent.join("source");
        std::fs::create_dir(&source).unwrap();
        git_with(&source, &[], &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(source.join("a.txt"), b"hello").unwrap();
        git_with(&source, &[], &["add", "a.txt"]);
        git_with(&source, &[], &["commit", "--quiet", "-m", "first"]);
        source
    }

    #[test]
    fn local_clone_streams_progress_and_detects_the_new_repository() {
        let source_dir = tempfile::tempdir().unwrap();
        let source = make_source(source_dir.path());
        let parent = tempfile::tempdir().unwrap();
        let state = CloneState::default();
        let mut lines: Vec<String> = Vec::new();
        let result = clone_repository(
            &state,
            source.to_str().unwrap(),
            parent.path(),
            &mut |line| lines.push(line.to_owned()),
        )
        .unwrap();
        assert!(result.success, "{}", result.message);
        assert!(!result.cancelled);
        assert!(result.residue.is_none());
        assert!(parent.path().join("source").join(".git").exists());
        assert!(
            !lines.is_empty(),
            "clone --progress produced no stderr lines"
        );
    }

    #[test]
    fn a_pending_cancellation_request_stops_the_clone() {
        let source_dir = tempfile::tempdir().unwrap();
        let source = make_source(source_dir.path());
        let parent = tempfile::tempdir().unwrap();
        let state = CloneState::default();
        state.cancelled.store(true, Ordering::SeqCst);
        let result =
            clone_repository(&state, source.to_str().unwrap(), parent.path(), &mut |_| {}).unwrap();
        assert!(!result.success);
        assert!(result.cancelled);
        assert_eq!(result.residue, residue_of(Path::new(&result.target)));
    }

    #[test]
    fn an_occupied_target_is_refused_before_git_runs() {
        let parent = tempfile::tempdir().unwrap();
        std::fs::create_dir(parent.path().join("source")).unwrap();
        std::fs::write(parent.path().join("source/keep.txt"), b"x").unwrap();
        let state = CloneState::default();
        let error = clone_repository(
            &state,
            "https://example.com/source.git",
            parent.path(),
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(error.code, "clone_target_occupied");
    }

    #[test]
    fn a_clone_refused_on_the_wire_is_classified_as_network() {
        // Loopback port 1: nothing can listen there unprivileged, so Git
        // fails fast and honestly on the same machine, no real network.
        let parent = tempfile::tempdir().unwrap();
        let state = CloneState::default();
        let result = clone_repository(
            &state,
            "http://127.0.0.1:1/nope.git",
            parent.path(),
            &mut |_| {},
        )
        .unwrap();
        assert!(!result.success && !result.cancelled, "{}", result.message);
        assert_eq!(
            result.category,
            Some(crate::netclassify::NetCategory::Network),
            "message: {}",
            result.message
        );
        assert_eq!(
            result.suggestion.as_deref(),
            Some(crate::netclassify::NetCategory::Network.suggestion())
        );
    }

    #[test]
    fn empty_and_fresh_targets_are_not_residue() {
        let parent = tempfile::tempdir().unwrap();
        assert_eq!(residue_of(&parent.path().join("fresh")), None);
        let empty = parent.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        assert_eq!(residue_of(&empty), None);
        let junk = parent.path().join("junk");
        std::fs::create_dir(&junk).unwrap();
        std::fs::write(junk.join("part"), b"x").unwrap();
        assert_eq!(residue_of(&junk), Some(repo::to_display(&junk)));
    }

    #[test]
    fn progress_redacts_credentials_in_urls() {
        let raw = b"fetch https://user:secret@example.com/repo: boom\n\r";
        let mut lines = Vec::new();
        emit_line(raw, &mut |line| lines.push(line.to_owned()));
        assert_eq!(lines.len(), 1);
        assert!(!lines[0].contains("secret"), "{}", lines[0]);
    }
}
