//! Diagnostics ring buffer and export serializer (M6-06, plan decision 11).
//! Red line: an export never leaves the machine without the user confirming
//! it, and it carries zero secrets. Two feed points only — constructed
//! `ProbeError`s (already URL-redacted by construction) and perf marks — and
//! the export surface is a fixed serializer whose types have no field that
//! could hold a ticket, token, prompt payload, commit message, file content
//! or repository path. Home-directory prefixes fold to `~`.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

pub const RING_CAPACITY: usize = 256;
pub const SUMMARY_LIMIT: usize = 120;

#[derive(Clone)]
pub struct Entry {
    pub kind: &'static str,
    pub name: String,
    pub ms: u64,
    pub summary: String,
    pub at_ms: u64,
}

fn ring() -> &'static Mutex<VecDeque<Entry>> {
    static RING: OnceLock<Mutex<VecDeque<Entry>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(RING_CAPACITY)))
}

fn now_ms() -> u64 {
    crate::perf::since_start().as_millis() as u64
}

/// Fold the user's home directory (both platform spellings) to `~` so error
/// summaries and resolved paths never smuggle account names out.
pub(crate) fn fold_home(text: &str) -> String {
    let mut folded = text.to_owned();
    for key in ["HOME", "USERPROFILE"] {
        if let Some(home) = std::env::var_os(key) {
            let home = home.to_string_lossy();
            if home.len() >= 2 && !home.contains('~') {
                folded = folded.replace(home.as_ref(), "~");
                let windows_spelling = home.replace('/', "\\");
                if windows_spelling != *home {
                    folded = folded.replace(&windows_spelling, "~");
                }
            }
        }
    }
    folded
}

fn truncate_bytes(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

pub(crate) fn record(kind: &'static str, name: String, ms: u64, summary: String) {
    let summary = truncate_bytes(&fold_home(&summary), SUMMARY_LIMIT);
    let mut buffer = ring().lock().unwrap();
    if buffer.len() == RING_CAPACITY {
        buffer.pop_front();
    }
    buffer.push_back(Entry {
        kind,
        name,
        ms,
        summary,
        at_ms: now_ms(),
    });
}

pub(crate) fn perf_mark(phase: &str, elapsed: std::time::Duration) {
    record(
        "perf",
        phase.to_owned(),
        elapsed.as_millis() as u64,
        String::new(),
    );
}

pub(crate) fn error(code: &str, message: &str) {
    record("error", code.to_owned(), 0, message.to_owned());
}

pub(crate) fn snapshot() -> Vec<Entry> {
    ring().lock().unwrap().iter().cloned().collect()
}

/// One config-directory file: name, size and declared schema version. Paths
/// and file bodies are deliberately unrepresentable here.
pub struct ConfigFile {
    pub name: String,
    pub size: u64,
    pub schema_version: Option<u64>,
}

/// Everything the exporter may show. The type itself is the contract: no
/// field accepts a credential, ticket, prompt, commit message or path.
pub struct Facts<'a> {
    pub app_version: &'a str,
    pub os: &'a str,
    pub arch: &'a str,
    pub git_available: bool,
    pub git_version: Option<&'a str>,
    pub git_executable: Option<&'a str>,
    pub credential_policy: Option<&'a str>,
    pub credential_helpers: &'a [String],
    pub ssh_agent: bool,
    pub remote_schemes: &'a [(String, Vec<String>)],
    pub remotes: &'a [(String, Option<String>, Option<String>)],
    pub watch_mode: &'a str,
    pub config_files: Vec<ConfigFile>,
    pub entries: Vec<Entry>,
}

/// Fixed key order, one fact per line; a missing section states why rather
/// than going silent.
pub(crate) fn export_text(facts: &Facts) -> String {
    let mut text = String::new();
    text.push_str("guit diagnostics export\n");
    text.push_str(&format!("app_version: {}\n", facts.app_version));
    text.push_str(&format!("platform: {} {}\n", facts.os, facts.arch));
    text.push_str(&format!(
        "git: {}\n",
        match (facts.git_available, facts.git_version, facts.git_executable) {
            (true, Some(version), Some(executable)) =>
                format!("{} at {}", version, fold_home(executable)),
            (true, Some(version), None) => version.to_owned(),
            _ => "not found on PATH".to_owned(),
        }
    ));
    text.push_str(&format!("watch_mode: {}\n", facts.watch_mode));
    text.push_str("credentials:\n");
    match facts.credential_policy {
        Some(policy) => {
            text.push_str(&format!("  policy: {policy}\n"));
            text.push_str(&format!(
                "  helpers: {}\n",
                facts.credential_helpers.join(", ")
            ));
            text.push_str(&format!("  ssh_agent: {}\n", facts.ssh_agent));
            for (scheme, names) in facts.remote_schemes {
                text.push_str(&format!("  scheme {scheme}: {}\n", names.join(", ")));
            }
        }
        None => text.push_str("  no repository session (posture not probed)\n"),
    }
    text.push_str("remotes (redacted):\n");
    if facts.remotes.is_empty() {
        text.push_str("  none\n");
    }
    for (name, fetch, push) in facts.remotes {
        text.push_str(&format!(
            "  {name}: fetch={} push={}\n",
            fetch.as_deref().unwrap_or("-"),
            push.as_deref().unwrap_or("-")
        ));
    }
    text.push_str("config files (name, bytes, schema version):\n");
    if facts.config_files.is_empty() {
        text.push_str("  none\n");
    }
    for file in &facts.config_files {
        text.push_str(&format!(
            "  {} {} {}\n",
            file.name,
            file.size,
            file.schema_version
                .map(|version| version.to_string())
                .unwrap_or_else(|| "-".to_owned())
        ));
    }
    text.push_str("recent events (newest last):\n");
    for entry in &facts.entries {
        text.push_str(&format!(
            "  {} +{}ms {} {}{}\n",
            entry.kind,
            entry.at_ms,
            entry.name,
            if entry.kind == "perf" {
                format!("ms={}", entry.ms)
            } else {
                "failed".to_owned()
            },
            if entry.summary.is_empty() {
                String::new()
            } else {
                format!(" | {}", entry.summary)
            }
        ));
    }
    text.push_str(
        "excluded by design: credentials, tokens, confirmation tickets, prompts, \
         commit messages, file contents, repository paths (home folded to ~)\n",
    );
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::ProbeError;

    #[test]
    fn the_ring_holds_the_newest_two_hundred_and_fifty_six_events() {
        for index in 0..(RING_CAPACITY + 64) {
            diagnostics_marker(index);
        }
        let entries = snapshot();
        assert_eq!(entries.len(), RING_CAPACITY);
        assert!(snapshot()
            .iter()
            .all(|entry| entry.summary.len() <= SUMMARY_LIMIT));
    }

    fn diagnostics_marker(index: usize) {
        record(
            "perf",
            format!("test.ring.{index}"),
            1,
            "x".repeat(SUMMARY_LIMIT * 3),
        );
    }

    #[test]
    fn error_feed_folds_home_and_bounds_the_summary() {
        let home = std::env::var("HOME").expect("test host has a home");
        if home.len() < 2 {
            return;
        }
        let _ = ProbeError::new(
            "test_diagnostics_feed",
            format!("could not lock {home}/secret-vault/.git: Permission denied"),
        );
        let entry = snapshot()
            .into_iter()
            .rev()
            .find(|entry| entry.name == "test_diagnostics_feed")
            .expect("constructed errors land in the ring");
        assert!(
            !entry.summary.contains(&home),
            "home leaked: {}",
            entry.summary
        );
        assert!(entry.summary.contains('~'));
        assert!(entry.summary.len() <= SUMMARY_LIMIT);
    }

    #[test]
    fn url_credentials_are_redacted_before_they_reach_the_ring() {
        let _ = ProbeError::new(
            "test_diagnostics_url",
            "fatal: unable to access https://user:hunter2@github.com/org/repo.git/",
        );
        let entry = snapshot()
            .into_iter()
            .rev()
            .find(|entry| entry.name == "test_diagnostics_url")
            .expect("constructed errors land in the ring");
        assert!(!entry.summary.contains("hunter2"));
        assert!(!entry.summary.contains("user@"));
        assert!(entry.summary.contains("[redacted]"));
    }

    fn empty_facts(entries: Vec<Entry>) -> Facts<'static> {
        Facts {
            app_version: "0.1.0",
            os: "linux",
            arch: "x86_64",
            git_available: true,
            git_version: Some("git version 2.53.0"),
            git_executable: None,
            credential_policy: None,
            credential_helpers: &[],
            ssh_agent: false,
            remote_schemes: &[],
            remotes: &[],
            watch_mode: "watch",
            config_files: vec![],
            entries,
        }
    }

    #[test]
    fn the_exporter_carries_no_sentinel_it_was_not_given() {
        // Sentinels standing for every excluded class. The types make most
        // of them unrepresentable; the test asserts the textual surface.
        let facts = Facts {
            git_executable: Some("/home/victim/programs/git"),
            credential_policy: Some("askpass bridge active"),
            credential_helpers: &["store".to_owned()],
            remote_schemes: &[("https".to_owned(), vec!["origin".to_owned()])],
            remotes: &[(
                "origin".to_owned(),
                Some("https://[redacted]@github.com/org/repo.git".to_owned()),
                None,
            )],
            config_files: vec![ConfigFile {
                name: "session.json".to_owned(),
                size: 41,
                schema_version: Some(1),
            }],
            ..empty_facts(vec![Entry {
                kind: "error",
                name: "commit_message_rejected".to_owned(),
                ms: 0,
                summary: "prepare-commit-msg hook said no".to_owned(),
                at_ms: 7,
            }])
        };
        let text = export_text(&facts);
        for sentinel in [
            "hunter2-super-secret-token",
            "SENTINEL-commit message",
            "SENTINEL-prompt payload",
            "SENTINEL-ticket-nonce",
        ] {
            assert!(!text.contains(sentinel), "export leaked {sentinel}");
        }
        let home = std::env::var("HOME").unwrap_or_default();
        if home.len() >= 2 {
            assert!(!text.contains(&home), "export leaked the home directory");
        }
        assert!(text.contains("~"));
        assert!(text.contains("session.json 41 1"));
        assert!(text.contains("prepare-commit-msg hook said no"));
    }

    #[test]
    fn truncation_never_splits_a_utf8_character() {
        let text = "断".repeat(200);
        let cut = truncate_bytes(&fold_home(&text), 7);
        assert!(cut.is_char_boundary(cut.len()));
        // Two 3-byte characters fit in 7 bytes; the third would straddle.
        assert_eq!(cut, "断".repeat(2));
    }
}
