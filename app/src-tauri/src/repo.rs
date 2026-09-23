use crate::probe::ProbeError;
use crate::runner;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct RepoIdentity {
    pub candidate: PathBuf,
    pub work_root: Option<PathBuf>,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    pub is_bare: bool,
    pub linked_worktree: bool,
}

pub fn user_git_command(path: &Path) -> Command {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    command
}

fn rev_parse_line(path: &Path, flag: &str) -> Result<Option<String>, ProbeError> {
    let mut command = user_git_command(path);
    command.arg("rev-parse").arg(flag);
    let output = runner::run(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(10),
        |_| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "repo_probe_unexpected",
            "Repository probe produced an oversized response.",
        ));
    }
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok((!text.is_empty()).then_some(text))
}

fn as_path(raw: &str) -> PathBuf {
    PathBuf::from(OsStr::new(raw))
}

pub fn detect(candidate: &Path) -> Result<RepoIdentity, ProbeError> {
    if !candidate.is_dir() {
        return Err(ProbeError::new(
            "repo_path_missing",
            "The selected folder does not exist or is not a directory.",
        ));
    }
    let not_repository = || {
        ProbeError::new(
            "not_a_repository",
            "The selected folder is not inside a Git repository. Choose the repository root \
             or install Git, then set the git executable location.",
        )
    };
    let inside_work_tree =
        rev_parse_line(candidate, "--is-inside-work-tree")?.ok_or_else(not_repository)?;
    let inside_work_tree = inside_work_tree == "true";
    let is_bare =
        rev_parse_line(candidate, "--is-bare-repository")?.ok_or_else(not_repository)? == "true";
    if !inside_work_tree && !is_bare {
        return Err(not_repository());
    }
    let git_dir =
        as_path(&rev_parse_line(candidate, "--absolute-git-dir")?.ok_or_else(not_repository)?);
    let common_raw = rev_parse_line(candidate, "--git-common-dir")?.ok_or_else(not_repository)?;
    let common_dir = if as_path(&common_raw).is_absolute() {
        as_path(&common_raw)
    } else {
        candidate.join(common_raw)
    };
    let work_root = if is_bare {
        None
    } else {
        rev_parse_line(candidate, "--show-toplevel")?
            .as_deref()
            .map(as_path)
    };
    if !git_dir.exists() {
        return Err(ProbeError::new(
            "repo_probe_unexpected",
            "Git reported a metadata directory that cannot be read.",
        ));
    }
    let linked_worktree = work_root.as_ref().is_some_and(|root| {
        // A `.git` file (linked worktree or submodule) resolves the real
        // metadata dir away from the per-worktree location below the root.
        let per_worktree = root.join(".git");
        crate::util::same_path(&git_dir, &per_worktree) != Some(true)
    });
    Ok(RepoIdentity {
        candidate: candidate.to_path_buf(),
        work_root,
        git_dir,
        common_dir,
        is_bare,
        linked_worktree,
    })
}

pub fn to_display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Debug, Clone)]
pub enum WorkDirError {
    Bare,
    Missing,
}

impl RepoIdentity {
    pub fn work_dir(&self) -> Result<&Path, WorkDirError> {
        match &self.work_root {
            Some(root) if root.is_dir() => Ok(root),
            Some(_) => Err(WorkDirError::Missing),
            None => Err(WorkDirError::Bare),
        }
    }
}

pub fn status_output(identity: &RepoIdentity, untracked: bool) -> Result<Vec<u8>, ProbeError> {
    let directory = if identity.is_bare {
        &identity.git_dir
    } else {
        identity
            .work_dir()
            .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))?
    };
    let mut command = user_git_command(directory);
    command.args([
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files",
        if untracked { "all" } else { "normal" },
        "--ignored=no",
    ]);
    if identity.is_bare {
        command
            .env("GIT_DIR", &identity.git_dir)
            .arg("--no-optional-locks");
    }
    let output = runner::run(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        |_| {},
    )?;
    if !output.status.success() {
        return Err(ProbeError::new(
            "git_status_failed",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn git_raw(dir: &Path, args: &[&str]) {
        git_with(dir, &[], args)
    }

    fn git_init(dir: &Path, name: &str, email: &str) {
        git_with(
            dir,
            &[
                "-c",
                &format!("user.name={name}"),
                "-c",
                &format!("user.email={email}"),
            ],
            &["init", "--quiet"],
        );
    }

    fn git_with(dir: &Path, pre: &[&str], args: &[&str]) {
        let status = Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .args(pre)
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_AUTHOR_NAME", "guit test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "guit test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git");
        assert!(status.success(), "git {pre:?} {args:?} failed");
    }

    fn init_bare(dir: &Path) {
        git_raw(dir, &["init", "--bare", "--quiet", "."]);
    }

    #[test]
    fn plain_repository_is_detected() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git_init(&repo, "guit test", "test@example.invalid");
        let identity = detect(&repo).unwrap();
        assert!(!identity.is_bare);
        assert!(!identity.linked_worktree);
        assert_eq!(
            crate::util::same_path(
                identity.work_root.as_ref().unwrap(),
                repo.canonicalize().unwrap().as_path()
            ),
            Some(true)
        );
        assert!(identity.git_dir.ends_with(".git"));
    }

    #[test]
    fn folder_outside_any_repository_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let error = detect(root.path()).unwrap_err();
        assert_eq!(error.code, "not_a_repository");
    }

    #[test]
    fn missing_path_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let error = detect(&root.path().join("nope")).unwrap_err();
        assert_eq!(error.code, "repo_path_missing");
    }

    #[test]
    fn nested_subfolder_resolves_to_the_repository_root() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(repo.join("deep/deeper")).unwrap();
        git_init(&repo, "guit test", "test@example.invalid");
        let identity = detect(&repo.join("deep/deeper")).unwrap();
        assert!(identity.git_dir.exists());
        assert!(identity
            .work_root
            .unwrap()
            .to_string_lossy()
            .contains("repo"));
    }

    #[test]
    fn bare_repository_has_no_work_root() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("pure.git");
        std::fs::create_dir(&repo).unwrap();
        init_bare(&repo);
        let identity = detect(&repo).unwrap();
        assert!(identity.is_bare);
        assert!(identity.work_root.is_none());
        assert_eq!(identity.git_dir, repo.canonicalize().unwrap());
    }

    #[test]
    fn linked_worktree_with_dot_git_file_is_detected() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git_init(&repo, "guit test", "test@example.invalid");
        git_raw(&repo, &["commit", "--quiet", "--allow-empty", "-m", "seed"]);
        let linked = root.path().join("linked");
        git_raw(
            &repo,
            &[
                "worktree",
                "add",
                "--quiet",
                linked.to_str().unwrap(),
                "-b",
                "side",
            ],
        );
        // The `.git` in the linked worktree is a file, not a directory.
        assert!(linked.join(".git").is_file());
        let identity = detect(&linked).unwrap();
        assert!(!identity.is_bare);
        assert!(identity.linked_worktree);
        assert!(identity.git_dir.is_dir());
        assert!(identity
            .git_dir
            .to_string_lossy()
            .contains(&format!("worktrees{}", std::path::MAIN_SEPARATOR)));
    }

    #[test]
    fn status_output_can_be_collected_for_each_repository_shape() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git_init(&repo, "guit test", "test@example.invalid");
        let output = status_output(&detect(&repo).unwrap(), true).unwrap();
        assert!(output.starts_with(b"# branch.oid "));
        let bare = root.path().join("bare.git");
        std::fs::create_dir(&bare).unwrap();
        init_bare(&bare);
        // `git status` cannot run against a bare repository; the failure must
        // surface as a structured error instead of a falsely clean repository.
        let error = status_output(&detect(&bare).unwrap(), true).unwrap_err();
        assert_eq!(error.code, "git_status_failed");
    }
}
