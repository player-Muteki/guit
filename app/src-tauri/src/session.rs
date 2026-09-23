use crate::model::{BranchView, FileView, PathTable};
use crate::probe::ProbeError;
use crate::repo::{self, RepoIdentity};
use crate::status;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const RECENT_LIMIT: usize = 10;
const RECENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Default)]
pub struct SessionState {
    current: Mutex<Option<ActiveRepo>>,
}

#[derive(Debug)]
struct ActiveRepo {
    identity: RepoIdentity,
    #[allow(dead_code)]
    paths: PathTable,
}

impl SessionState {
    pub(crate) fn current_identity(&self) -> Option<RepoIdentity> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .map(|active| active.identity.clone())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoView {
    pub open_path: String,
    pub root: Option<String>,
    pub git_dir: String,
    pub bare: bool,
    pub linked_worktree: bool,
}

impl RepoView {
    fn from_identity(identity: &RepoIdentity) -> RepoView {
        RepoView {
            open_path: repo::to_display(&identity.candidate),
            root: identity.work_root.as_deref().map(repo::to_display),
            git_dir: repo::to_display(&identity.git_dir),
            bare: identity.is_bare,
            linked_worktree: identity.linked_worktree,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotView {
    pub repo: RepoView,
    /// Null for bare repositories, where Git refuses to report a status.
    pub branch: Option<BranchView>,
    pub files: Vec<FileView>,
}

/// Detect the repository, read one status snapshot and only then replace the
/// session. Any failure leaves the previously open repository untouched.
pub fn open(state: &SessionState, path: &Path) -> Result<SnapshotView, ProbeError> {
    let identity = repo::detect(path)?;
    let snapshot = capture(&identity)?;
    *state.current.lock().unwrap() = Some(snapshot.active);
    Ok(snapshot.view)
}

struct Capture {
    active: ActiveRepo,
    view: SnapshotView,
}

fn capture(identity: &RepoIdentity) -> Result<Capture, ProbeError> {
    if identity.is_bare {
        return Ok(Capture {
            active: ActiveRepo {
                identity: identity.clone(),
                paths: PathTable::default(),
            },
            view: SnapshotView {
                repo: RepoView::from_identity(identity),
                branch: None,
                files: Vec::new(),
            },
        });
    }
    let raw = repo::status_output(identity, true)?;
    let parsed = status::parse(&raw)?;
    let (paths, files) = PathTable::from_status(&parsed);
    let view = SnapshotView {
        repo: RepoView::from_identity(identity),
        branch: Some(BranchView::from_parsed(&parsed)),
        files,
    };
    Ok(Capture {
        active: ActiveRepo {
            identity: identity.clone(),
            paths,
        },
        view,
    })
}

pub fn close(state: &SessionState) {
    *state.current.lock().unwrap() = None;
}

/// Reopen the stored session after an application start. A repository that
/// disappeared since last run clears the session instead of failing startup.
pub fn restore(state: &SessionState) -> Result<Option<SnapshotView>, ProbeError> {
    let Some(identity) = state.current_identity() else {
        return Ok(None);
    };
    match capture(&identity) {
        Ok(snapshot) => {
            *state.current.lock().unwrap() = Some(snapshot.active);
            Ok(Some(snapshot.view))
        }
        Err(error) => {
            close(state);
            if matches!(
                error.code,
                "repo_path_missing" | "not_a_repository" | "repo_worktree_missing"
            ) {
                Ok(None)
            } else {
                Err(ProbeError::new(
                    error.code,
                    format!(
                        "The previous repository cannot be reopened: {}",
                        error.message
                    ),
                ))
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct RecentFile {
    schema_version: u32,
    paths: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionFile {
    schema_version: u32,
    path: String,
}

fn session_path(config_dir: &Path) -> PathBuf {
    config_dir.join("session.json")
}

pub fn record_session(config_dir: &Path, path: &str) -> Result<(), ProbeError> {
    write_json_atomic(
        &session_path(config_dir),
        &SessionFile {
            schema_version: RECENT_SCHEMA_VERSION,
            path: path.to_owned(),
        },
        "session",
    )
}

pub fn clear_session(config_dir: &Path) -> Result<(), ProbeError> {
    match fs::remove_file(session_path(config_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ProbeError::new("session_write_failed", error.to_string())),
    }
}

pub fn read_session(config_dir: &Path) -> Result<Option<String>, ProbeError> {
    match fs::read(session_path(config_dir)) {
        Ok(data) => {
            let file: SessionFile = serde_json::from_slice(&data)
                .map_err(|error| ProbeError::new("session_decode_failed", error.to_string()))?;
            if file.schema_version != RECENT_SCHEMA_VERSION {
                return Err(ProbeError::new(
                    "session_invalid",
                    "Unsupported session file version.",
                ));
            }
            Ok(Some(file.path))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ProbeError::new("session_read_failed", error.to_string())),
    }
}

fn write_json_atomic<T: Serialize>(
    path: &Path,
    value: &T,
    tag: &'static str,
) -> Result<(), ProbeError> {
    let encode = |e: serde_json::Error| ProbeError::new(tag, e.to_string());
    let io = |e: std::io::Error| ProbeError::new(tag, e.to_string());
    let data = serde_json::to_vec(value).map_err(encode)?;
    let parent = path
        .parent()
        .ok_or_else(|| ProbeError::new("session_path_failed", "Invalid file path"))?;
    fs::create_dir_all(parent).map_err(io)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io)?;
    temporary.write_all(&data).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(path).map_err(|error| io(error.error))?;
    Ok(())
}

fn recent_path(config_dir: &Path) -> PathBuf {
    config_dir.join("recent.json")
}

pub fn read_recent(config_dir: &Path) -> Result<Vec<String>, ProbeError> {
    match fs::read(recent_path(config_dir)) {
        Ok(data) => {
            let file: RecentFile = serde_json::from_slice(&data)
                .map_err(|error| ProbeError::new("recent_decode_failed", error.to_string()))?;
            if file.schema_version != RECENT_SCHEMA_VERSION {
                return Err(ProbeError::new(
                    "recent_invalid",
                    "Unsupported recent repositories file version.",
                ));
            }
            Ok(file.paths)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(ProbeError::new("recent_read_failed", error.to_string())),
    }
}

pub fn record_recent(config_dir: &Path, path: &str) -> Result<Vec<String>, ProbeError> {
    let list = push_recent(read_recent(config_dir)?, path)?;
    let data = serde_json::to_vec(&RecentFile {
        schema_version: RECENT_SCHEMA_VERSION,
        paths: list.clone(),
    })
    .map_err(|error| ProbeError::new("recent_encode_failed", error.to_string()))?;
    fs::create_dir_all(config_dir)
        .map_err(|error| ProbeError::new("recent_write_failed", error.to_string()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(config_dir)
        .map_err(|error| ProbeError::new("recent_write_failed", error.to_string()))?;
    temporary
        .write_all(&data)
        .map_err(|error| ProbeError::new("recent_write_failed", error.to_string()))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| ProbeError::new("recent_write_failed", error.to_string()))?;
    temporary
        .persist(recent_path(config_dir))
        .map(|_| ())
        .map_err(|error| ProbeError::new("recent_write_failed", error.to_string()))?;
    Ok(list)
}

pub fn push_recent(mut list: Vec<String>, path: &str) -> Result<Vec<String>, ProbeError> {
    let key = recent_key(path)?;
    list.retain(|entry| {
        recent_key(entry)
            .map(|entry_key| entry_key != key)
            .unwrap_or(false)
    });
    list.insert(0, path.to_owned());
    list.truncate(RECENT_LIMIT);
    Ok(list)
}

fn recent_key(path: &str) -> Result<String, ProbeError> {
    let canonical = fs::canonicalize(path).map_err(|_| {
        ProbeError::new(
            "recent_path_invalid",
            "The repository path cannot be recorded as recent.",
        )
    })?;
    let key = canonical.to_string_lossy().into_owned();
    if !Path::new(path).is_dir() || key.contains('\0') {
        return Err(ProbeError::new(
            "recent_path_invalid",
            "Only existing directories can be recorded as recent.",
        ));
    }
    #[cfg(windows)]
    return Ok(key.to_ascii_lowercase());
    #[cfg(not(windows))]
    return Ok(key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::HeadState;

    struct Fixture {
        root: tempfile::TempDir,
        repo: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir(&repo).unwrap();
        repo::git_with(
            &repo,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            &["init", "--quiet", "--initial-branch=main"],
        );
        Fixture { root, repo }
    }

    #[test]
    fn open_reports_branch_and_files() {
        let fixture = fixture();
        fs::write(fixture.repo.join("untracked.txt"), "new\n").unwrap();
        let state = SessionState::default();
        let snapshot = open(&state, &fixture.repo).unwrap();
        let branch = snapshot
            .branch
            .expect("non-bare repository has a branch view");
        assert_eq!(branch.name.as_deref(), Some("main"));
        assert_eq!(branch.head_state, HeadState::Unborn);
        assert_eq!(branch.oid, None);
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].display, "untracked.txt");
        assert!(!snapshot.repo.bare);
        assert_eq!(
            snapshot.repo.root.as_deref(),
            Some(fixture.repo.to_str().unwrap())
        );
    }

    #[test]
    fn failed_open_keeps_the_previous_session() {
        let fixture = fixture();
        let state = SessionState::default();
        open(&state, &fixture.repo).unwrap();
        let missing = fixture.root.path().join("nope");
        let error = open(&state, &missing).unwrap_err();
        assert_eq!(error.code, "repo_path_missing");
        assert!(state.current_identity().is_some());
        let not_repo = fixture.root.path().join("plain");
        fs::create_dir(&not_repo).unwrap();
        assert_eq!(
            open(&state, &not_repo).unwrap_err().code,
            "not_a_repository"
        );
        assert_eq!(state.current_identity().unwrap().candidate, fixture.repo);
    }

    #[test]
    fn close_and_restore_track_the_session() {
        let fixture = fixture();
        let state = SessionState::default();
        assert!(restore(&state).unwrap().is_none());
        open(&state, &fixture.repo).unwrap();
        assert!(restore(&state).unwrap().is_some());
        close(&state);
        assert!(restore(&state).unwrap().is_none());
        assert!(state.current_identity().is_none());
    }

    #[test]
    fn restore_drops_a_repository_that_no_longer_exists() {
        let fixture = fixture();
        let state = SessionState::default();
        open(&state, &fixture.repo).unwrap();
        drop(fixture);
        assert!(restore(&state).unwrap().is_none());
        assert!(state.current_identity().is_none());
    }

    #[test]
    fn bare_repository_opens_without_a_work_tree() {
        let root = tempfile::tempdir().unwrap();
        let bare = root.path().join("bare.git");
        fs::create_dir(&bare).unwrap();
        repo::git_with(
            &bare,
            &[],
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        let state = SessionState::default();
        let snapshot = open(&state, &bare).unwrap();
        assert!(snapshot.repo.bare);
        assert!(snapshot.repo.root.is_none());
        assert!(snapshot.branch.is_none());
        assert!(snapshot.files.is_empty());
    }

    #[test]
    fn recent_list_dedupes_newest_first_and_caps() {
        let root = tempfile::tempdir().unwrap();
        let mut directories = Vec::new();
        for index in 0..(RECENT_LIMIT + 3) {
            let directory = root.path().join(format!("repo{index}"));
            fs::create_dir(&directory).unwrap();
            directories.push(directory.to_str().unwrap().to_owned());
        }
        let mut list = Vec::new();
        for path in directories[0..RECENT_LIMIT + 2].iter() {
            list = push_recent(list, path).unwrap();
        }
        assert_eq!(list.len(), RECENT_LIMIT);
        assert_eq!(list[0], directories[RECENT_LIMIT + 1]);
        let reused = &directories[3];
        list = push_recent(list, reused).unwrap();
        assert_eq!(&list[0], reused);
        assert_eq!(
            list.iter()
                .filter(|entry| Path::new(entry) == Path::new(reused))
                .count(),
            1
        );
    }

    #[test]
    fn recent_file_round_trips_and_rejects_garbage() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        let directory = root.path().join("repo");
        fs::create_dir(&directory).unwrap();
        assert!(read_recent(&config).unwrap().is_empty());
        let list = record_recent(&config, directory.to_str().unwrap()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(read_recent(&config).unwrap(), list);
        fs::write(recent_path(&config), b"not json").unwrap();
        assert_eq!(
            read_recent(&config).unwrap_err().code,
            "recent_decode_failed"
        );
    }

    #[test]
    fn session_file_round_trips_and_clears() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        assert!(read_session(&config).unwrap().is_none());
        record_session(&config, "/some/repo").unwrap();
        assert_eq!(
            read_session(&config).unwrap().as_deref(),
            Some("/some/repo")
        );
        clear_session(&config).unwrap();
        assert!(read_session(&config).unwrap().is_none());
        clear_session(&config).unwrap();
    }

    #[test]
    fn nonexistent_paths_are_not_recorded_as_recent() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("gone");
        assert_eq!(
            push_recent(Vec::new(), missing.to_str().unwrap())
                .unwrap_err()
                .code,
            "recent_path_invalid"
        );
        let file = root.path().join("a-file");
        fs::write(&file, b"x").unwrap();
        assert_eq!(
            push_recent(Vec::new(), file.to_str().unwrap())
                .unwrap_err()
                .code,
            "recent_path_invalid"
        );
    }
}
