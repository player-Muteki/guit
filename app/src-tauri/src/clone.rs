use crate::probe::{redact, Code, ProbeError};
use crate::repo::{self, user_git_command};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A clone may run for hours, so guit never bounds its total duration. It
/// bounds *silence* instead: `--progress` output is a heartbeat, so a
/// transfer that is merely slow keeps living and a transfer that stopped
/// reporting is stopped itself.
pub const CLONE_STALL_TIMEOUT: Duration = Duration::from_secs(120);
/// How often the watchdog looks at the heartbeat.
const CLONE_STALL_POLL: Duration = Duration::from_millis(50);

/// One clone may run at a time; cancellation is requested through the same
/// flag the process runner polls.
#[derive(Default)]
pub struct CloneState {
    pub cancelled: AtomicBool,
    pub running: AtomicBool,
}

/// The moment Git last said anything, plus the verdict the watchdog reached.
struct StallWatch {
    last_beat: Mutex<Instant>,
    stalled: AtomicBool,
    stopped: AtomicBool,
}

impl Default for StallWatch {
    fn default() -> Self {
        Self {
            last_beat: Mutex::new(Instant::now()),
            stalled: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        }
    }
}

impl StallWatch {
    fn beat(&self) {
        *crate::util::guard(&self.last_beat) = Instant::now();
    }

    fn expired(&self, silence: Duration) -> bool {
        crate::util::guard(&self.last_beat).elapsed() >= silence
    }

    /// Kills the clone the heartbeat stops, and records that it was guit —
    /// not the user — who asked, so the report can say so honestly.
    fn watch(&self, cancelled: &AtomicBool, silence: Duration) {
        loop {
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            if self.expired(silence) {
                self.stalled.store(true, Ordering::SeqCst);
                cancelled.store(true, Ordering::SeqCst);
                return;
            }
            std::thread::sleep(CLONE_STALL_POLL);
        }
    }
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
    // A directory Git emptied is no residue; anything else is. A `read_dir`
    // that fails cannot prove the directory is empty, so it fails closed and
    // counts as residue.
    let occupied = if target.is_dir() {
        match std::fs::read_dir(target) {
            Ok(mut entries) => entries.next().is_some(),
            Err(_) => true,
        }
    } else {
        true
    };
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
    clone_within_silence_limit(state, source, parent, CLONE_STALL_TIMEOUT, on_line)
}

fn clone_within_silence_limit(
    state: &CloneState,
    source: &str,
    parent: &Path,
    silence: Duration,
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
    let watch = StallWatch::default();
    let mut buffer: Vec<u8> = Vec::new();
    let mut emit_lines = |is_stderr: bool, bytes: &[u8]| {
        if !bytes.is_empty() {
            watch.beat();
        }
        if !is_stderr {
            return;
        }
        buffer.extend_from_slice(bytes);
        while let Some(position) = buffer.iter().position(|b| *b == b'\n' || *b == b'\r') {
            let line: Vec<u8> = buffer.drain(..=position).collect();
            emit_line(&line, on_line);
        }
    };
    let output = std::thread::scope(|scope| {
        let watcher = scope.spawn(|| watch.watch(&state.cancelled, silence));
        let output = crate::runner::run_with_limit(
            command,
            &state.cancelled,
            Duration::ZERO,
            Duration::MAX,
            256 * 1024,
            &mut emit_lines,
        );
        watch.stopped.store(true, Ordering::SeqCst);
        let _ = watcher.join();
        output
    });
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
        Err(error) if error.code == Code::PROCESS_CANCELLED => {
            if watch.stalled.load(Ordering::SeqCst) {
                // Not the user: Git stopped talking, so guit stopped it.
                // Saying "cancelled" here would hide the actual failure.
                (
                    false,
                    false,
                    format!(
                        "Git reported nothing for {} seconds, so guit stopped the clone. Check the connection to the remote and start it again.",
                        silence.as_secs().max(1)
                    ),
                    None,
                )
            } else {
                (false, true, "Clone cancelled.".to_owned(), None)
            }
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
        .map(redact)
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
        assert!(result.cancelled);
        assert_eq!(result.message, "Clone cancelled.");
    }

    // Removing the watchdog brings back the old failure: a remote that stops
    // talking leaves the clone waiting forever, so this test hangs rather
    // than fails — which is exactly what it is guarding.
    #[test]
    fn a_clone_that_stops_reporting_is_stopped_and_says_so() {
        let source_dir = tempfile::tempdir().unwrap();
        let source = make_source(source_dir.path());
        let parent = tempfile::tempdir().unwrap();
        let state = CloneState::default();
        let silence = Duration::ZERO;
        let started = std::time::Instant::now();
        let result = clone_within_silence_limit(
            &state,
            source.to_str().unwrap(),
            parent.path(),
            silence,
            &mut |_| {},
        )
        .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the silent clone was waited on, not stopped"
        );
        assert!(!result.success);
        assert!(
            !result.cancelled,
            "guit stopped this clone, so reporting it as the user's \
             cancellation hides what happened: {}",
            result.message
        );
        assert!(
            result.message.contains("reported nothing"),
            "{}",
            result.message
        );
        assert!(state.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn only_silence_expires_the_watch_and_any_report_resets_it() {
        let watch = StallWatch::default();
        assert!(!watch.expired(Duration::from_secs(120)));
        // Backdate the heartbeat the way a dead transfer would.
        *crate::util::guard(&watch.last_beat) = Instant::now() - Duration::from_secs(121);
        assert!(watch.expired(Duration::from_secs(120)));
        watch.beat();
        assert!(!watch.expired(Duration::from_secs(120)));
        assert!(!watch.stalled.load(Ordering::SeqCst));
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
        assert_eq!(error.code.as_str(), "clone_target_occupied");
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
