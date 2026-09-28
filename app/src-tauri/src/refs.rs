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
const FIELD_COUNT: usize = 8;
const REF_FORMAT: &str = "%(refname)\u{1f}%(objecttype)\u{1f}%(objectname)\u{1f}%(*objectname)\u{1f}%(HEAD)\u{1f}%(upstream)\u{1f}%(upstream:track)\u{1f}%(symref)";
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
    /// Annotated tags carry this object; lightweight tags point at the
    /// commit themselves.
    pub oid: String,
    /// Commit the tag resolves to (peeled), when Git could dereference it.
    pub target_oid: Option<String>,
    pub annotated: bool,
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
        if !is_oid(oid) || (!peeled.is_empty() && !is_oid(peeled)) {
            return Err(protocol_error());
        }
        if !head_flag.is_empty() && head_flag != " " && head_flag != "*" {
            return Err(protocol_error());
        }
        let annotated = object_type == "tag";
        if object_type != "commit" && !annotated {
            return Err(protocol_error());
        }
        if refname.starts_with(b"refs/heads/") {
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
            listing.tags.push(TagRef {
                name: short_display(refname, "refs/tags/"),
                oid: oid.to_owned(),
                target_oid: (!peeled.is_empty()).then(|| peeled.to_owned()),
                annotated,
                addressable: addressable(refname),
            });
        } else if refname.starts_with(b"refs/remotes/") {
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
        assert_eq!(annotated.target_oid.as_deref(), Some(oid.as_str()));
        assert_ne!(annotated.oid, oid, "annotated oid is the tag object");
        let light = listing.tags.iter().find(|t| t.name == "light").unwrap();
        assert!(!light.annotated);
        assert_eq!(light.target_oid, None);
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
