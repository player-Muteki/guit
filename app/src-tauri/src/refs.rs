use crate::model::display_name;
use crate::perf;
use crate::probe::{redact, ProbeError};
use crate::{history, repo, runner};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

/// Field separator inside one ref record. Git forbids ASCII control
/// characters (< 0x20) in reference names, so neither the 0x1f separator
/// nor the LF record terminator can ever appear in the one free-form
/// field — unlike commit messages, refs need no NUL trickery.
const FIELD_SEP: u8 = 0x1f;
const RECORD_SEP: u8 = b'\n';
const FIELD_COUNT: usize = 9;
/// `%(*objectname)` and `%(*objecttype)` are Git's own peel of a tag object:
/// both are empty for every ref that is not one, and both name the object the
/// tag finally stands for (verified on Git 2.53, including a tag whose peel is
/// itself a tag object).
const REF_FORMAT: &str = "%(refname)\u{1f}%(objecttype)\u{1f}%(objectname)\u{1f}%(*objectname)\u{1f}%(HEAD)\u{1f}%(upstream)\u{1f}%(upstream:track)\u{1f}%(symref)\u{1f}%(*objecttype)";
/// Repos mirroring hundreds of remotes can carry a very large ref db.
const REF_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchRef {
    /// Display name under `refs/heads/` (control bytes escaped); never
    /// convertible back into a ref name by the frontend.
    pub name: String,
    pub oid: String,
    pub head: bool,
    /// Upstream without the `refs/remotes/` prefix, display form.
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub upstream_gone: bool,
    /// True when the raw ref name is valid UTF-8 and survives the display
    /// round trip; only such refs can be addressed by write operations.
    pub addressable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRef {
    pub name: String,
    pub oid: String,
    /// Display target when the ref is symbolic (e.g. `origin/HEAD`).
    pub symref: Option<String>,
    /// True when the raw ref name is byte-exact UTF-8; only such refs can
    /// be handed back as upstream targets or deleted.
    pub addressable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    pub name: String,
    /// The object the ref itself points at: the tag object for an annotated
    /// tag, the named thing for a lightweight one. This is what a delete has to
    /// match; it is not necessarily what the tag is *about*.
    pub oid: String,
    /// Git's word for the object the tag stands for once peeled: `commit`,
    /// `tree`, `blob`. A tag may name any object, so this is never assumed to
    /// be a commit — and an object type Git adds later is reported as Git said
    /// it rather than refused.
    pub target_type: String,
    /// The commit this tag names, when it names one: the id a label joins a row
    /// of a history on. `None` for a tag on a tree or a blob, which is a name
    /// with no row to sit on rather than a read that failed.
    pub commit_oid: Option<String>,
    pub annotated: bool,
    /// True when the raw ref name is valid UTF-8 and survives the display
    /// round trip; only such tags can be addressed by write operations.
    pub addressable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefListing {
    pub branches: Vec<BranchRef>,
    pub remotes: Vec<RemoteRef>,
    pub tags: Vec<TagRef>,
}

fn protocol_error() -> ProbeError {
    ProbeError::new(
        "refs_protocol_error",
        "Git returned references in an unexpected format; refusing to parse them.",
    )
}

fn is_oid(value: &str) -> bool {
    history::valid_oid(value)
}

fn addressable(raw: &[u8]) -> bool {
    // A lossy display name could alias another ref; only byte-exact UTF-8
    // round trips may be handed back to the backend as an address.
    std::str::from_utf8(raw).is_ok()
}

fn short_display(raw: &[u8], prefix: &str) -> String {
    display_name(raw.strip_prefix(prefix.as_bytes()).unwrap_or(raw))
}

/// Parses one `%(field)`-separated, LF-terminated line; fail-closed on any
/// unexpected shape.
fn parse_fields(line: &[u8]) -> Result<Vec<&[u8]>, ProbeError> {
    let fields: Vec<&[u8]> = line.split(|b| *b == FIELD_SEP).collect();
    if fields.len() != FIELD_COUNT {
        return Err(protocol_error());
    }
    Ok(fields)
}

pub fn parse_listing(bytes: &[u8]) -> Result<RefListing, ProbeError> {
    let mut listing = RefListing {
        branches: Vec::new(),
        remotes: Vec::new(),
        tags: Vec::new(),
    };
    for line in bytes.split(|b| *b == RECORD_SEP) {
        if line.is_empty() {
            continue;
        }
        let fields = parse_fields(line)?;
        let refname = fields[0];
        let object_type = std::str::from_utf8(fields[1]).map_err(|_| protocol_error())?;
        let oid = std::str::from_utf8(fields[2]).map_err(|_| protocol_error())?;
        let peeled = std::str::from_utf8(fields[3]).map_err(|_| protocol_error())?;
        let head_flag = std::str::from_utf8(fields[4]).map_err(|_| protocol_error())?;
        let upstream = fields[5];
        let track = String::from_utf8_lossy(fields[6]).into_owned();
        let symref = fields[7];
        let peel_type = std::str::from_utf8(fields[8]).map_err(|_| protocol_error())?;
        if !is_oid(oid) || (!peeled.is_empty() && !is_oid(peeled)) {
            return Err(protocol_error());
        }
        if !head_flag.is_empty() && head_flag != " " && head_flag != "*" {
            return Err(protocol_error());
        }
        let annotated = object_type == "tag";
        // Only a tag object carries a peel. A record that answers a peel while
        // denying being one is not the format this parser was written against,
        // and choosing which half to believe would put a name on an object Git
        // never pointed at.
        if (!peeled.is_empty() || !peel_type.is_empty()) && !annotated {
            return Err(protocol_error());
        }
        if refname.starts_with(b"refs/heads/") {
            // A branch that does not name a commit is not a branch: Git refuses
            // to make one (measured on Git 2.53, where `update-ref
            // refs/heads/x <blob>` fails), so neither a read nor a write of this
            // panel has a meaning for it.
            if object_type != "commit" {
                return Err(protocol_error());
            }
            let (ahead, behind, gone) = parse_track(&track);
            listing.branches.push(BranchRef {
                name: short_display(refname, "refs/heads/"),
                oid: oid.to_owned(),
                head: head_flag == "*",
                upstream: (!upstream.is_empty()).then(|| short_display(upstream, "refs/remotes/")),
                ahead,
                behind,
                upstream_gone: gone,
                addressable: addressable(refname),
            });
        } else if refname.starts_with(b"refs/tags/") {
            // A tag naming a tree or a blob is legitimate Git — `git tag -a`
            // takes any object — so it is a name reported with what it names,
            // not a listing that failed. An annotated tag whose peel is missing
            // would leave the name sitting on a tag object no history row
            // exists for, and that shape is refused rather than resolved by
            // guessing what Git meant to peel.
            let (target_type, target_oid) = if annotated {
                if peeled.is_empty() || peel_type.is_empty() {
                    return Err(protocol_error());
                }
                (peel_type.to_owned(), peeled.to_owned())
            } else {
                (object_type.to_owned(), oid.to_owned())
            };
            listing.tags.push(TagRef {
                name: short_display(refname, "refs/tags/"),
                oid: oid.to_owned(),
                target_type: target_type.clone(),
                commit_oid: (target_type == "commit").then_some(target_oid),
                annotated,
                addressable: addressable(refname),
            });
        } else if refname.starts_with(b"refs/remotes/") {
            if object_type != "commit" {
                return Err(protocol_error());
            }
            listing.remotes.push(RemoteRef {
                name: short_display(refname, "refs/remotes/"),
                oid: oid.to_owned(),
                symref: (!symref.is_empty()).then(|| short_display(symref, "refs/")),
                addressable: addressable(refname),
            });
        } else {
            // The patterns asked for exactly the three namespaces above.
            return Err(protocol_error());
        }
    }
    Ok(listing)
}

/// `[ahead 2, behind 1]`, `[gone]`, combinations — unknown tokens are
/// ignored (a listing must survive a future Git adding one), but the
/// brackets themselves are mandatory when the field is non-empty.
fn parse_track(track: &str) -> (Option<u64>, Option<u64>, bool) {
    let mut ahead = None;
    let mut behind = None;
    let mut gone = false;
    let Some(inner) = track.strip_prefix('[').and_then(|t| t.strip_suffix(']')) else {
        // Empty (no upstream) or an unrecognized shape: counts simply stay
        // unknown — a listing must never fail on display metadata.
        return (None, None, false);
    };
    for token in inner.split(", ") {
        let mut parts = token.splitn(2, ' ');
        match (parts.next(), parts.next()) {
            (Some("ahead"), Some(n)) => ahead = n.parse().ok(),
            (Some("behind"), Some(n)) => behind = n.parse().ok(),
            (Some("gone"), None) => gone = true,
            _ => {}
        }
    }
    (ahead, behind, gone)
}

/// Read-only ref listing for the open repository. Bare repositories are
/// fine here: for-each-ref only needs the object and ref database.
pub fn list(directory: &Path) -> Result<RefListing, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args([
        "for-each-ref",
        &format!("--format={REF_FORMAT}"),
        "refs/heads",
        "refs/tags",
        "refs/remotes",
    ]);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        REF_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "refs_truncated",
            "The ref listing exceeded the capture bound; nothing was parsed.",
        ));
    }
    if !output.status.success() {
        let detail = redact(&String::from_utf8_lossy(&output.stderr));
        let first_line = detail.lines().next().unwrap_or("").to_owned();
        return Err(ProbeError::new("refs_list_failed", first_line));
    }
    if !output.stderr.is_empty() {
        // Git skips a ref it cannot parse and says so on stderr while still
        // exiting 0: the listing that comes back is shorter than the repository.
        // A name silently missing is worse than no listing, because the panel
        // would render it as a name that does not exist — so the same rule
        // `status` follows applies here: a partial answer is a failed read.
        return Err(ProbeError::new(
            "refs_unavailable",
            "Git left a reference out of the listing; the whole listing was refused.",
        ));
    }
    let parse_start = Instant::now();
    let listing = parse_listing(&output.stdout);
    perf::mark("refs.parse", parse_start.elapsed());
    listing
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        repo::git_with(
            root.path(),
            &[],
            &["init", "--quiet", "--initial-branch=main"],
        );
        root
    }

    fn commit(dir: &Path, message: &str) -> String {
        repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            &["commit", "-q", "--allow-empty", "-m", message],
        );
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

    #[test]
    fn branches_tags_and_remotes_are_listed_with_head_and_peel() {
        let root = fixture();
        let dir = root.path();
        let oid = commit(dir, "one");
        repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            &["tag", "-a", "annotated", "-m", "tag message"],
        );
        repo::git_with(dir, &[], &["tag", "light", &oid]);
        repo::git_with(dir, &[], &["branch", "keep", &oid]);
        repo::git_with(
            dir,
            &[],
            &["remote", "add", "origin", &dir.to_string_lossy()],
        );
        repo::git_with(dir, &[], &["update-ref", "refs/remotes/origin/x", &oid]);
        repo::git_with(
            dir,
            &[],
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/heads/main",
            ],
        );

        let listing = list(dir).unwrap();
        assert_eq!(listing.branches.len(), 2);
        let main = listing
            .branches
            .iter()
            .find(|b| b.name == "main")
            .expect("main listed");
        assert!(main.head);
        assert_eq!(main.oid, oid);
        assert!(main.addressable);
        assert!(
            !listing
                .branches
                .iter()
                .find(|b| b.name == "keep")
                .unwrap()
                .head
        );
        let annotated = listing.tags.iter().find(|t| t.name == "annotated").unwrap();
        assert!(annotated.annotated);
        assert_eq!(annotated.commit_oid.as_deref(), Some(oid.as_str()));
        assert_eq!(annotated.target_type, "commit");
        assert_ne!(annotated.oid, oid, "annotated oid is the tag object");
        let light = listing.tags.iter().find(|t| t.name == "light").unwrap();
        assert!(!light.annotated);
        // A lightweight tag names the commit directly, so it labels the same row
        // an annotated one does — through a different object.
        assert_eq!(light.commit_oid.as_deref(), Some(oid.as_str()));
        assert_eq!(light.oid, oid);
        let head_sym = listing
            .remotes
            .iter()
            .find(|r| r.name == "origin/HEAD")
            .unwrap();
        assert_eq!(head_sym.symref.as_deref(), Some("heads/main"));
        assert!(listing
            .remotes
            .iter()
            .any(|r| r.name == "origin/x" && r.symref.is_none()));
    }

    /// Runs one Git command the way `commit` does and hands back its stdout,
    /// for the fixtures that need an object id rather than the effect of a write.
    fn git_stdout(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
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
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    /// The id of an object a tag may name and a branch may not: `blob` reads
    /// from a file written into the work tree, `tree` from the commit just made.
    fn object_oid(dir: &Path, kind: &str) -> String {
        match kind {
            "blob" => {
                std::fs::write(dir.join("named-by-a-tag.txt"), "not a commit\n").unwrap();
                git_stdout(dir, &["hash-object", "-w", "--", "named-by-a-tag.txt"])
            }
            "tree" => git_stdout(dir, &["rev-parse", "HEAD^{tree}"]),
            other => panic!("no fixture object named {other}"),
        }
    }

    /// A tag on anything but a commit is ordinary Git (`git tag -a` takes any
    /// object id), and it is a name with no history row to sit on. Refusing the
    /// whole namespace for it would hide every branch of a repository whose user
    /// tagged a tree once — so the type is reported, the join id is absent, and
    /// the rest of the listing stands. Measured on Git 2.53: a lightweight tag
    /// on a blob is listed with rc 0 as `blob`, and an annotated one peels to
    /// the blob it names.
    #[test]
    fn a_tag_naming_something_else_is_a_name_with_no_row_and_a_said_type() {
        let root = fixture();
        let dir = root.path();
        let oid = commit(dir, "one");
        let blob = object_oid(dir, "blob");
        let tree = object_oid(dir, "tree");
        repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            &["tag", "-a", "blobbed", "-m", "on a blob", &blob],
        );
        repo::git_with(dir, &[], &["tag", "light-blob", &blob]);
        repo::git_with(dir, &[], &["tag", "treeish", &tree]);
        repo::git_with(dir, &[], &["tag", "on-commit", &oid]);

        let listing = list(dir).expect("one odd tag does not refuse the namespace");
        let blobbed = listing
            .tags
            .iter()
            .find(|t| t.name == "blobbed")
            .expect("the annotated blob tag is listed");
        assert!(blobbed.annotated);
        assert_eq!(blobbed.target_type, "blob");
        assert_eq!(blobbed.commit_oid, None, "a blob is not a commit");
        assert_eq!(
            blobbed.oid.as_str(),
            git_stdout(dir, &["rev-parse", "refs/tags/blobbed"]).as_str(),
            "the ref points at the tag object, which is what a delete must match"
        );
        let light = listing
            .tags
            .iter()
            .find(|t| t.name == "light-blob")
            .expect("the lightweight blob tag is listed");
        assert!(!light.annotated);
        assert_eq!(light.target_type, "blob");
        assert_eq!(light.oid, blob, "a lightweight ref names the object");
        assert_eq!(light.commit_oid, None);
        assert_eq!(
            listing
                .tags
                .iter()
                .find(|t| t.name == "treeish")
                .expect("a tree is a third thing a tag can name")
                .target_type,
            "tree"
        );
        // The listing is not merely surviving the odd tag: the ordinary name in
        // the same namespace still answers with the commit it labels.
        assert_eq!(
            listing
                .tags
                .iter()
                .find(|t| t.name == "on-commit")
                .expect("the commit tag is listed")
                .commit_oid
                .as_deref(),
            Some(oid.as_str())
        );
        assert_eq!(listing.branches.len(), 1);
    }

    /// A lightweight ref aimed at a tag object is still a tag object to Git: the
    /// peel runs through it, so the name lands on the commit the inner tag
    /// names. Measured on Git 2.53, where the peeled id and its type both come
    /// back for `%(objecttype) == "tag"` regardless of how the ref got there.
    #[test]
    fn a_ref_aimed_at_a_tag_object_is_peeled_to_what_that_tag_names() {
        let root = fixture();
        let dir = root.path();
        let oid = commit(dir, "one");
        repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            &["tag", "-a", "inner", "-m", "the first tag"],
        );
        let inner = git_stdout(dir, &["rev-parse", "refs/tags/inner"]);
        repo::git_with(dir, &[], &["update-ref", "refs/tags/through", &inner]);

        let listing = list(dir).unwrap();
        let through = listing
            .tags
            .iter()
            .find(|t| t.name == "through")
            .expect("the ref through a tag object is listed");
        assert_eq!(through.target_type, "commit");
        assert_eq!(through.commit_oid.as_deref(), Some(oid.as_str()));
        assert_eq!(through.oid, inner, "its own object is the tag");
    }

    /// A branch is a commit or nothing: `update-ref` refuses to write a branch
    /// that names a blob (measured on Git 2.53), so a listing carrying one is
    /// either a future Git or a repository written to by hand. Neither is
    /// something the panel should draw a switchable name for, and `refs::list`
    /// has no way to tell which half of the record to believe — so the whole
    /// listing is refused, the way every other unusable answer is.
    #[test]
    fn a_branch_naming_a_non_commit_refuses_the_listing() {
        let root = fixture();
        let dir = root.path();
        commit(dir, "one");
        let blob = object_oid(dir, "blob");
        // Hand-made, because Git's own plumbing will not write this shape.
        std::fs::write(dir.join(".git/refs/heads/blobhand"), format!("{blob}\n")).unwrap();
        let error = list(dir).unwrap_err();
        assert_eq!(error.code.as_str(), "refs_protocol_error");
        std::fs::remove_file(dir.join(".git/refs/heads/blobhand")).unwrap();
        assert_eq!(
            list(dir).expect("the listing returns").branches.len(),
            1,
            "one impossible name is what failed the read"
        );
    }

    #[test]
    fn upstream_ahead_behind_and_gone_are_parsed() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        repo::git_with(&source, &[], &["init", "--quiet", "--initial-branch=main"]);
        commit(&source, "one");
        let fresh = root.path().join("fresh");
        repo::git_with(
            root.path(),
            &[],
            &[
                "clone",
                "-q",
                "--",
                &source.to_string_lossy(),
                &fresh.to_string_lossy(),
            ],
        );
        let idle = list(&fresh).unwrap();
        let idle_main = idle.branches.iter().find(|b| b.name == "main").unwrap();
        // Git leaves %(upstream:track) empty when neither side moved, so
        // "in sync" means no counts at all rather than zeros.
        assert_eq!(
            (
                idle_main.upstream.as_deref(),
                idle_main.ahead,
                idle_main.behind,
                idle_main.upstream_gone
            ),
            (Some("origin/main"), None, None, false)
        );

        // Local commit → ahead 1.
        commit(&fresh, "local");
        let ahead = list(&fresh).unwrap();
        let ahead_main = ahead.branches.iter().find(|b| b.name == "main").unwrap();
        assert_eq!((ahead_main.ahead, ahead_main.behind), (Some(1), None));

        // Remote advances too → diverging counts.
        commit(&source, "remote");
        repo::git_with(&fresh, &[], &["fetch", "-q", "origin"]);
        let diverged = list(&fresh).unwrap();
        let d = diverged.branches.iter().find(|b| b.name == "main").unwrap();
        assert_eq!((d.ahead, d.behind), (Some(1), Some(1)));

        // Upstream ref deleted on the source and pruned locally → [gone]
        // survives as a flag, not a parse error.
        repo::git_with(&source, &[], &["update-ref", "-d", "refs/heads/main"]);
        repo::git_with(&fresh, &[], &["fetch", "-q", "--prune", "origin"]);
        let gone = list(&fresh).unwrap();
        let g = gone.branches.iter().find(|b| b.name == "main").unwrap();
        assert!(g.upstream_gone, "track gone: {:?}", g);
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_ref_names_display_but_are_not_addressable() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let root = fixture();
        let dir = root.path();
        let oid = commit(dir, "one");
        // git_with only takes &str; a raw non-UTF8 ref name needs OsStr args
        // with the same isolated environment.
        let status = std::process::Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .arg("-C")
            .arg(dir)
            .args(["branch", "--"])
            .arg(OsStr::from_bytes(b"keep\xff"))
            .arg(&oid)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .status()
            .expect("git");
        assert!(status.success(), "branch create failed");
        let listing = list(dir).unwrap();
        let odd = listing
            .branches
            .iter()
            .find(|b| b.name == "keep\u{fffd}")
            .expect("lossy display name");
        assert!(!odd.addressable);
        assert_eq!(odd.oid, oid);
        assert!(listing
            .branches
            .iter()
            .any(|b| b.name == "main" && b.addressable));
    }

    #[test]
    fn parsing_fails_closed_on_unexpected_shapes() {
        // Too few fields.
        assert_eq!(
            parse_listing(b"refs/heads/main\x1fcommit\x1fabc\n".as_slice())
                .unwrap_err()
                .code
                .as_str(),
            "refs_protocol_error"
        );
        // Unknown namespace (patterns are supposed to prevent this).
        let line = format!(
            "refs/weird/main\u{1f}commit\u{1f}{}\u{1f}\u{1f} \u{1f}\u{1f}\u{1f}\n",
            "a".repeat(40)
        );
        assert_eq!(
            parse_listing(line.as_bytes()).unwrap_err().code.as_str(),
            "refs_protocol_error"
        );
        // Malformed object id.
        let line = "refs/heads/main\u{1f}commit\u{1f}not-an-oid\u{1f}\u{1f}*\u{1f}\u{1f}\u{1f}\n";
        assert_eq!(
            parse_listing(line.as_bytes()).unwrap_err().code.as_str(),
            "refs_protocol_error"
        );
        // Unknown object type.
        let line = format!(
            "refs/heads/main\u{1f}blob\u{1f}{}\u{1f}\u{1f} \u{1f}\u{1f}\u{1f}\n",
            "a".repeat(40)
        );
        assert_eq!(
            parse_listing(line.as_bytes()).unwrap_err().code.as_str(),
            "refs_protocol_error"
        );
        // Empty input is a legitimate empty listing (fresh unborn repo).
        assert_eq!(parse_listing(&[]).unwrap().branches.len(), 0);
    }

    /// Git exits 0 and *skips* a reference it cannot parse, putting the
    /// complaint on stderr. The listing that comes back is then shorter than the
    /// repository, and a name silently missing is rendered as a repository that
    /// has no such name — so a partial answer is refused whole, the way an
    /// incomplete status is. Measured on this host's Git 2.53: a loose ref whose
    /// content is not an object id is dropped with a warning, rc still 0.
    #[test]
    fn a_ref_git_skips_refuses_the_whole_listing() {
        let root = fixture();
        let dir = root.path();
        commit(dir, "one");
        std::fs::write(dir.join(".git/refs/heads/ghost"), "not-an-object-name\n").unwrap();
        let error = list(dir).unwrap_err();
        assert_eq!(error.code.as_str(), "refs_unavailable");
        assert!(!error.message.is_empty());
        // The same repository with the broken name gone answers again: this is
        // one bad ref refusing the listing, not a listing that cannot be read.
        std::fs::remove_file(dir.join(".git/refs/heads/ghost")).unwrap();
        let listing = list(dir).expect("the listing returns");
        assert_eq!(listing.branches.len(), 1);
    }

    /// A reference that parses but points at an object the repository does not
    /// have is a different shape: Git refuses the whole read rather than
    /// inventing a shorter answer.
    #[test]
    fn a_ref_whose_object_is_gone_is_a_failed_read() {
        let root = fixture();
        let dir = root.path();
        commit(dir, "one");
        std::fs::write(
            dir.join(".git/refs/heads/ghost"),
            "0123456789012345678901234567890123456789\n",
        )
        .unwrap();
        let error = list(dir).unwrap_err();
        assert_eq!(error.code.as_str(), "refs_list_failed");
        assert!(!error.message.is_empty());
    }

    #[test]
    fn track_parser_reads_documented_forms() {
        assert_eq!(parse_track(""), (None, None, false));
        assert_eq!(parse_track("[ahead 3]"), (Some(3), None, false));
        assert_eq!(parse_track("[behind 2]"), (None, Some(2), false));
        assert_eq!(
            parse_track("[ahead 1, behind 4]"),
            (Some(1), Some(4), false)
        );
        assert_eq!(parse_track("[gone]"), (None, None, true));
        // Unknown future tokens must not poison the known counters.
        assert_eq!(parse_track("[ahead 9, teleported]"), (Some(9), None, false));
    }
}
