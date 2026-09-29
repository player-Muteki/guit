use crate::probe::ProbeError;
use crate::runner;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoIdentity {
    pub candidate: PathBuf,
    pub work_root: Option<PathBuf>,
    pub git_dir: PathBuf,
    /// Shared metadata directory, watched alongside `git_dir`: a linked
    /// worktree that moves a shared branch changes this directory, and the
    /// status has to follow. Read by `watch::watch_targets`.
    pub common_dir: PathBuf,
    pub is_bare: bool,
    pub linked_worktree: bool,
}

/// The one sanitized git invocation every guit read and write builds on.
/// Beyond stripping the inherited `GIT_*` variables, it pins two local-only
/// controls: `-c submodule.recurse=false` (top-level, so it must be set
/// before the subcommand is appended) stops `switch`/`merge`/`reset` from
/// letting Git implicitly update — and download — submodules, and
/// `GIT_NO_LAZY_FETCH=1` (set after the strip so it survives) stops a
/// partial clone from fetching missing objects on demand. A git that errors
/// because of either control fails the read or write that ran it; it is
/// never a clean repository.
pub fn user_git_command(path: &Path) -> Command {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .current_dir(path)
        .arg("-c")
        .arg("submodule.recurse=false")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("LC_ALL", "C");
    command
}

/// Fork of [`user_git_command`] for the two Git paths that measured-required
/// an editor on Git 2.53 (`merge --continue`, conflicted `rebase --continue`).
/// `GIT_EDITOR=:` makes Git's editor invocation a no-op that accepts the
/// standard message; every other command keeps the inherited user setup.
/// Windows behavior of `:` as an editor is unverified.
pub fn user_git_command_noninteractive(path: &Path) -> Command {
    let mut command = user_git_command(path);
    command.env("GIT_EDITOR", ":");
    command
}

/// A merge/rebase/cherry-pick step may run an editor or a long checkout, so
/// it gets far longer than an ordinary read.
const SEQUENCE_TIMEOUT: Duration = Duration::from_secs(600);

/// Everything a caller chooses when it invokes Git in a work tree: the
/// arguments, how long to wait, the caller's cancellation flag, and whether
/// the command is one of the two that measured-require a no-op editor.
/// Together with [`git`] this is the one way guit runs Git, so the sanitized
/// command, the timeout and the cancel source are composed in one place
/// instead of restated by every caller. Build it with [`GitRun::read`],
/// [`GitRun::sequence`] or [`GitRun::paths`].
pub struct GitRun<'a> {
    args: &'a [&'a str],
    cancelled: &'a AtomicBool,
    timeout: Duration,
    /// The two `--continue` paths that would otherwise open an editor.
    noninteractive: bool,
    /// Raw-path targets appended after a `--` separator, so a path can
    /// never be read as an option. `Some` (even empty) always emits the
    /// separator: that is the path-scoped form callers mean when they reach
    /// for this field.
    paths: Option<&'a [OsString]>,
}

impl<'a> GitRun<'a> {
    /// An ordinary read: the user's Git, the given arguments, a short
    /// timeout and the caller's cancel flag. Most calls want exactly this.
    pub fn read(args: &'a [&'a str], cancelled: &'a AtomicBool) -> Self {
        Self {
            args,
            cancelled,
            timeout: Duration::from_secs(60),
            noninteractive: false,
            paths: None,
        }
    }

    /// A merge/rebase/cherry-pick step, which may run an editor and takes
    /// far longer than a read.
    pub fn sequence(args: &'a [&'a str], cancelled: &'a AtomicBool, noninteractive: bool) -> Self {
        Self {
            args,
            cancelled,
            timeout: SEQUENCE_TIMEOUT,
            noninteractive,
            paths: None,
        }
    }

    /// A path-scoped write: `git <args…> -- <paths…>`, so a path can never
    /// be read as an option. The separator is always emitted.
    pub fn paths(args: &'a [&'a str], paths: &'a [OsString], cancelled: &'a AtomicBool) -> Self {
        Self {
            args,
            cancelled,
            timeout: Duration::from_secs(120),
            noninteractive: false,
            paths: Some(paths),
        }
    }
}

/// Runs Git in `work_root` with the arguments, timeout and cancel flag the
/// caller chose. This is the single seam for process spawning: every caller
/// builds its argv here, so process-group isolation, the exit-status event
/// and the capture limit are applied once, by the runner.
pub fn git(work_root: &Path, run: GitRun<'_>) -> Result<runner::CapturedOutput, ProbeError> {
    let mut command = if run.noninteractive {
        user_git_command_noninteractive(work_root)
    } else {
        user_git_command(work_root)
    };
    command.args(run.args);
    if let Some(paths) = run.paths {
        command.arg("--");
        command.args(paths);
    }
    runner::run_with_limit(
        command,
        run.cancelled,
        Duration::ZERO,
        run.timeout,
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )
}

fn rev_parse_line(path: &Path, flag: &str) -> Result<Option<String>, ProbeError> {
    let mut command = user_git_command(path);
    command.arg("rev-parse").arg(flag);
    let output = runner::run(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(10),
        |_, _| {},
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

pub fn detect(candidate: &Path) -> Result<RepoIdentity, ProbeError> {
    let started = std::time::Instant::now();
    let outcome = detect_inner(candidate);
    crate::perf::mark("detect.total", started.elapsed());
    outcome
}

fn as_path(raw: &str) -> PathBuf {
    PathBuf::from(OsStr::new(raw))
}

/// The five repository facts `rev-parse` reports about a directory.
struct ProbeFacts {
    inside_work_tree: bool,
    is_bare: bool,
    git_dir_raw: String,
    common_dir_raw: String,
    toplevel_raw: Option<String>,
}

/// One `git rev-parse --is-inside-work-tree --is-bare-repository
/// --absolute-git-dir --git-common-dir --show-toplevel` replacing the five
/// spawns `detect` used to make. Git 2.53 measured: a work tree prints
/// exactly five lines (`true`, `false`, absolute git dir, common dir,
/// absolute toplevel) and a bare repository prints exactly four (`false`,
/// `true`, git dir, common dir) because `--show-toplevel` contributes
/// nothing; the fatal notice for the first flag goes to stderr with exit 0.
/// Any other shape — an older Git rejecting a flag, a locale split, an
/// unexpected empty toplevel — returns `None` and the caller repeats the
/// original per-flag sequence, so the single spawn is an optimization that
/// can never change an outcome on its own.
fn rev_parse_facts(path: &Path) -> Option<ProbeFacts> {
    let mut command = user_git_command(path);
    command.args([
        "rev-parse",
        "--is-inside-work-tree",
        "--is-bare-repository",
        "--absolute-git-dir",
        "--git-common-dir",
        "--show-toplevel",
    ]);
    let output = runner::run(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(10),
        |_, _| {},
    )
    .ok()?;
    if output.truncated || !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() == 5
        && lines[0] == "true"
        && lines[1] == "false"
        && !lines[2].is_empty()
        && !lines[3].is_empty()
        && as_path(lines[4]).is_absolute()
    {
        return Some(ProbeFacts {
            inside_work_tree: true,
            is_bare: false,
            git_dir_raw: lines[2].to_owned(),
            common_dir_raw: lines[3].to_owned(),
            toplevel_raw: Some(lines[4].to_owned()),
        });
    }
    lines.truncate(4);
    if lines.len() == 4
        && lines[0] == "false"
        && lines[1] == "true"
        && !lines[2].is_empty()
        && !lines[3].is_empty()
    {
        return Some(ProbeFacts {
            inside_work_tree: false,
            is_bare: true,
            git_dir_raw: lines[2].to_owned(),
            common_dir_raw: lines[3].to_owned(),
            toplevel_raw: None,
        });
    }
    None
}

fn finish_detect(
    candidate: &Path,
    facts: ProbeFacts,
    not_repository: impl Fn() -> ProbeError,
) -> Result<RepoIdentity, ProbeError> {
    if !facts.inside_work_tree && !facts.is_bare {
        return Err(not_repository());
    }
    let git_dir = as_path(&facts.git_dir_raw);
    let common_dir = if as_path(&facts.common_dir_raw).is_absolute() {
        as_path(&facts.common_dir_raw)
    } else {
        candidate.join(facts.common_dir_raw)
    };
    let work_root = if facts.is_bare {
        None
    } else {
        facts.toplevel_raw.as_deref().map(as_path)
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
        is_bare: facts.is_bare,
        linked_worktree,
    })
}

fn detect_inner(candidate: &Path) -> Result<RepoIdentity, ProbeError> {
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
    if let Some(facts) = rev_parse_facts(candidate) {
        return finish_detect(candidate, facts, not_repository);
    }
    let inside_work_tree =
        rev_parse_line(candidate, "--is-inside-work-tree")?.ok_or_else(not_repository)?;
    let inside_work_tree = inside_work_tree == "true";
    let is_bare =
        rev_parse_line(candidate, "--is-bare-repository")?.ok_or_else(not_repository)? == "true";
    let git_dir = rev_parse_line(candidate, "--absolute-git-dir")?.ok_or_else(not_repository)?;
    let common_dir_raw =
        rev_parse_line(candidate, "--git-common-dir")?.ok_or_else(not_repository)?;
    let toplevel_raw = rev_parse_line(candidate, "--show-toplevel")?;
    finish_detect(
        candidate,
        ProbeFacts {
            inside_work_tree,
            is_bare,
            git_dir_raw: git_dir,
            common_dir_raw,
            toplevel_raw,
        },
        not_repository,
    )
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
    // `--no-optional-locks` is a top-level git option and must precede the
    // subcommand. Beyond skipping opportunistic index writes, it stops Git
    // from creating and removing `.git/index.lock` at all: those events fed
    // the file watcher, so a single real change made guit refresh forever
    // (measured on a tmpfs fixture: ~3.5 refreshes/s, never settling).
    command.args(["--no-optional-locks"]);
    // Option values must use the `=` form: `--untracked-files all` would treat
    // `all` as a pathspec and silently report an empty repository.
    command.args([
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        &format!(
            "--untracked-files={}",
            if untracked { "all" } else { "normal" }
        ),
        "--ignored=no",
    ]);
    if identity.is_bare {
        command.env("GIT_DIR", &identity.git_dir);
    }
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        runner::STATUS_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if !output.status.success() {
        return Err(ProbeError::new(
            "git_status_failed",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    if output.truncated {
        return Err(ProbeError::new(
            "git_status_truncated",
            "Status output exceeded the capture bound; refusing to parse a partial result.",
        ));
    }
    Ok(output.stdout)
}

/// Runs an isolated Git command for tests and asserts success. Global `-c`
/// overrides must go through `pre`: they precede the subcommand.
#[cfg(test)]
pub(crate) fn git_with(dir: &Path, pre: &[&str], args: &[&str]) {
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
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("git");
    assert!(status.success(), "git {pre:?} {args:?} failed");
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(error.code.as_str(), "not_a_repository");
    }

    #[test]
    fn missing_path_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let error = detect(&root.path().join("nope")).unwrap_err();
        assert_eq!(error.code.as_str(), "repo_path_missing");
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
        assert_eq!(error.code.as_str(), "git_status_failed");
    }

    #[test]
    fn status_output_never_acquires_the_index_lock() {
        // Git creates and deletes `.git/index.lock` on ordinary (non-bare)
        // status runs even when it rewrites nothing; those create/remove
        // events re-trigger guit's own file watcher, so one real change used
        // to make the refresh loop self-sustaining. The top-level
        // `--no-optional-locks` option must suppress the lock entirely.
        use notify::Watcher;
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git_init(&repo, "guit test", "test@example.invalid");
        std::fs::write(repo.join("file.txt"), b"one\n").unwrap();
        git_raw(&repo, &["add", "."]);
        git_with(
            &repo,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=test@example.invalid",
            ],
            &["commit", "-qm", "base"],
        );
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                if let Ok(event) = event {
                    for path in event.paths {
                        if path.file_name().is_some_and(|name| name == "index.lock") {
                            let _ = tx.send(());
                        }
                    }
                }
            })
            .unwrap();
        watcher
            .watch(&repo.join(".git"), notify::RecursiveMode::Recursive)
            .unwrap();
        let identity = detect(&repo).unwrap();
        status_output(&identity, true).unwrap();
        std::fs::write(repo.join("file.txt"), b"one\n").unwrap();
        status_output(&identity, true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(
            rx.try_iter().next().is_none(),
            "status took .git/index.lock"
        );
    }
}
