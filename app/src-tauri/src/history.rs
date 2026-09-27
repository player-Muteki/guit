use crate::perf;
use crate::probe::{redact, ProbeError};
use crate::{repo, runner};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

/// Field separator inside one log record (ASCII unit separator).
const FIELD_SEP: u8 = 0x1f;
/// Record separator emitted by `git log -z` (NUL). Git itself refuses to
/// create a commit whose message contains NUL ("a NUL byte in commit log
/// message not allowed"), so NUL is a reliable entry boundary; `%x1f` can
/// appear inside messages, which is why the message is the final field and
/// records are split with a field-count limit.
const RECORD_SEP: u8 = 0x00;
const FIELD_COUNT: usize = 10;
const LOG_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%D%x1f%B";
/// Topology-only format for the graph prefix. Oid + parents is ~82 bytes a
/// commit, so a ten-thousand-commit prefix stays far under the capture bound
/// and cannot trip `history_truncated`. Only the parents are ever needed to
/// assign lanes, so this cheaper format is what the graph is built from.
const TOPO_FORMAT: &str = "%H %P";
/// 100 commits with long messages can exceed the default capture bound.
const LOG_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
/// The gutter has room for this many lanes. A repository whose live lane
/// count would exceed it is drawn first-parent and says so, rather than
/// drawing lanes the gutter cannot hold.
pub const MAX_LANES: u8 = 24;
pub const PAGE_SIZE: u64 = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitView {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    /// Full message, newlines preserved; rendered with textContent only.
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub committer_name: String,
    pub commit_date: String,
    /// Raw `%D` decoration tokens ("HEAD -> main", "tag: v1", "origin/main").
    pub refs: Vec<String>,
    /// This commit's place in the graph, computed by the backend so the
    /// frontend only maps columns to pixels.
    pub graph: GraphRow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub start: u64,
    pub commits: Vec<CommitView>,
    pub has_more: bool,
}

/// One row of the commit graph. A renderer needs no other row to draw this
/// one: every segment that crosses the row, and every edge that leaves or
/// enters the node, is named here. That is what keeps the commit list
/// virtualised — a windowed row is drawn without consulting its neighbours.
///
/// All columns are indices into the fixed-width graph gutter, ascending in
/// `lanes`/`branches`, and a column is the same lane for the whole loaded
/// history of one HEAD, so a lane keeps its colour as you scroll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    /// Column of this commit's node.
    pub node: u8,
    /// A line arrives from above into this node: this commit has a child
    /// above it in the loaded history.
    pub entry: bool,
    /// A line leaves this node downward: its first parent is below.
    pub exit: bool,
    /// More than one parent.
    pub merge: bool,
    /// No parent at all: the first commit.
    pub root: bool,
    /// Columns, other than `node`, carrying a vertical line through this row.
    /// Each is a commit further down that is not this row's parent.
    pub lanes: Vec<u8>,
    /// Extra parent lanes that begin at this node, ascending. Each is drawn
    /// sideways from the node, then down.
    pub branches: Vec<u8>,
    /// Lanes that were carrying this same commit and stop here, ascending.
    /// Several branches commonly share one parent — every topic branch cut
    /// from the same base does — and those lanes all arrive at this one row
    /// rather than running past it.
    pub incoming: Vec<u8>,
    /// A parent lies below the loaded window, so this line continues past
    /// the last loaded row. The renderer shows it leaving the list rather
    /// than ending it as though the history stopped there.
    pub dangling: bool,
    /// The live lane count exceeded the gutter, so this row is drawn on the
    /// first-parent line only. Surfaced instead of drawn as a graph that
    /// would not fit.
    pub folded: bool,
}

/// A commit reduced to what lane assignment needs. Kept separate from
/// `CommitView` so the assignment is a pure function over topology and can
/// be tested without Git or a repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub oid: String,
    pub parents: Vec<String>,
}

/// Assigns every node a self-contained graph row, in display order.
///
/// Display order is topological with parents after children, so an edge
/// always points downward and a node's first parent continues its own
/// column — the mainline never jogs. Extra parents take the lowest free
/// column to the right, so a merge always flows the same way.
///
/// When the live lane count would exceed `max_lanes`, the whole window is
/// drawn first-parent and every row is marked `folded`: a graph that does
/// not fit the gutter must say so rather than draw lanes that collide.
pub fn assign_lanes(nodes: &[Node], max_lanes: u8) -> Vec<GraphRow> {
    if nodes.is_empty() {
        return Vec::new();
    }
    let present: std::collections::HashSet<&str> =
        nodes.iter().map(|node| node.oid.as_str()).collect();
    let (rows, peak) = layout(nodes, &present);
    if peak > usize::from(max_lanes) {
        return nodes
            .iter()
            .map(|node| folded_row(node, &present))
            .collect();
    }
    rows
}

/// The first-parent line, for a window too wide to draw. A commit with
/// several parents keeps only its first: the mainline stays continuous and
/// the branches that were dropped are exactly what `folded` announces.
fn folded_row(node: &Node, present: &std::collections::HashSet<&str>) -> GraphRow {
    GraphRow {
        node: 0,
        entry: !node.parents.is_empty(),
        exit: true,
        merge: node.parents.len() > 1,
        root: node.parents.is_empty(),
        lanes: Vec::new(),
        branches: Vec::new(),
        incoming: Vec::new(),
        dangling: node
            .parents
            .iter()
            .any(|parent| !present.contains(parent.as_str())),
        folded: true,
    }
}

/// Lowest free column at or after `from`, growing the gutter if every column
/// from there on is taken. Growth is the only way the width increases, and
/// it is monotone, so column `c` is the same lane for the whole window.
fn take_free(owner: &mut Vec<Option<&str>>, from: usize) -> usize {
    for column in from..owner.len() {
        if owner[column].is_none() {
            return column;
        }
    }
    owner.push(None);
    owner.len() - 1
}

/// Assigns lanes and reports how many columns were ever live at once. The
/// width is measured from the same pass that draws, so the fold decision can
/// never be made against a different algorithm than the one that renders.
fn layout(nodes: &[Node], present: &std::collections::HashSet<&str>) -> (Vec<GraphRow>, usize) {
    let mut owner: Vec<Option<&str>> = Vec::new();
    let mut rows = Vec::with_capacity(nodes.len());
    let mut peak = 0usize;
    for node in nodes {
        // A commit can be waiting in more than one lane: every branch that
        // shares this parent parks a copy of it, which is what a set of topic
        // branches cut from one base looks like. It is drawn once, in the
        // leftmost of those lanes, and the rest converge into that row — a
        // lane left holding a commit that has already been drawn would run
        // down the gutter forever.
        let held: Vec<usize> = owner
            .iter()
            .enumerate()
            .filter(|(_, waiting)| **waiting == Some(node.oid.as_str()))
            .map(|(column, _)| column)
            .collect();
        let column = held
            .first()
            .copied()
            .unwrap_or_else(|| take_free(&mut owner, 0));
        for waiting in &held {
            owner[*waiting] = None;
        }
        let incoming: Vec<u8> = held.iter().skip(1).map(|column| *column as u8).collect();
        let mut branches = Vec::new();
        let mut exit = false;
        for (index, parent) in node.parents.iter().enumerate() {
            if index == 0 {
                owner[column] = Some(parent);
                exit = true;
            } else {
                let branch = take_free(&mut owner, column + 1);
                owner[branch] = Some(parent);
                branches.push(branch as u8);
            }
        }
        peak = peak.max(owner.iter().filter(|waiting| waiting.is_some()).count());
        let lanes = (0..owner.len())
            .filter(|other| *other != column && owner[*other].is_some())
            .map(|other| other as u8)
            .collect();
        rows.push(GraphRow {
            node: column as u8,
            entry: !held.is_empty(),
            exit: exit && !node.parents.is_empty(),
            merge: node.parents.len() > 1,
            root: node.parents.is_empty(),
            lanes,
            branches,
            incoming,
            dangling: node
                .parents
                .iter()
                .any(|parent| !present.contains(parent.as_str())),
            folded: false,
        });
    }
    (rows, peak)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileView {
    /// Raw status token ("M", "A", "R100" — the score stays attached).
    pub status: String,
    /// Display name of the new-side path; never convertible back to bytes.
    pub path: String,
    /// Rename/copy source, display name only.
    pub old_path: Option<String>,
}

/// Accepts only full object ids, so a frontend value can never be a revspec
/// expression, option or path. Branch/tag listings hand out these ids.
pub(crate) fn valid_oid(candidate: &str) -> bool {
    (candidate.len() == 40 || candidate.len() == 64)
        && candidate.bytes().all(|b| b.is_ascii_hexdigit())
        && candidate.bytes().all(|b| !b.is_ascii_uppercase())
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Parses the byte stream produced by `LOG_FORMAT` with `-z` (verified on
/// Git 2.53: fields separated by 0x1f, each record terminated by 0x00,
/// `%B` trailing newline included).
///
/// `graph` must be the rows for the window starting at `start`, as laid out
/// over the whole prefix. It is a required argument rather than something the
/// caller attaches afterwards so that a `CommitView` cannot exist without the
/// graph row that describes where it sits: a commit drawn with a placeholder
/// would put its line in a column nobody else agrees on.
pub fn parse(
    bytes: &[u8],
    graph: &[GraphRow],
    start: usize,
) -> Result<Vec<CommitView>, ProbeError> {
    let mut commits = Vec::new();
    for record in bytes.split(|b| *b == RECORD_SEP) {
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&[u8]> = record
            .splitn(FIELD_COUNT, |byte| *byte == FIELD_SEP)
            .collect();
        if fields.len() != FIELD_COUNT {
            // Never guess around a partial record: a wrong field could be
            // rendered as a commit message or, worse, fed back as an argument.
            return Err(ProbeError::new(
                "history_protocol_error",
                "Git returned history in an unexpected format; refusing to parse it.",
            ));
        }
        let message = {
            let raw = fields[9];
            match raw.split_last() {
                Some((b'\n', rest)) => rest,
                _ => raw,
            }
        };
        let message = lossy(message);
        let subject = match message.lines().next() {
            Some(line) => crate::model::display_name(line.as_bytes()),
            None => String::new(),
        };
        let offset = start + commits.len();
        let row = graph.get(offset).ok_or_else(|| {
            // The two reads described different histories. Drawing a line to
            // a commit that is not the one this row holds would be a lie
            // about the shape of the history, so the page is refused.
            ProbeError::new(
                "history_graph_mismatch",
                "The history changed while the graph was being drawn; reload to try again.",
            )
        })?;
        commits.push(CommitView {
            oid: lossy(fields[0]),
            parents: lossy(fields[1])
                .split(' ')
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect(),
            subject,
            author_name: lossy(fields[2]),
            author_email: lossy(fields[3]),
            author_date: lossy(fields[4]),
            committer_name: lossy(fields[5]),
            commit_date: lossy(fields[7]),
            refs: lossy(fields[8])
                .split(", ")
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .collect(),
            message,
            graph: row.clone(),
        });
    }
    Ok(commits)
}

/// Parses the topology-only stream produced by `TOPO_FORMAT`: one commit
/// per line, `%H` then a space-separated `%P` (empty for a root commit).
/// Malformed lines are a protocol error, never a guessed parent.
fn parse_topology(bytes: &[u8]) -> Result<Vec<Node>, ProbeError> {
    let text = String::from_utf8_lossy(bytes);
    let mut nodes = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split(' ');
        let oid = parts.next().unwrap_or_default();
        if !valid_oid(oid) {
            return Err(ProbeError::new(
                "history_protocol_error",
                "Git returned commit topology in an unexpected format; refusing to draw the graph.",
            ));
        }
        let parents: Vec<String> = parts
            .filter(|parent| !parent.is_empty())
            .map(str::to_owned)
            .collect();
        // `%P` never contains a third field; anything else means the line is
        // not what this format produces.
        if parents.iter().any(|parent| !valid_oid(parent)) {
            return Err(ProbeError::new(
                "history_protocol_error",
                "Git returned commit topology in an unexpected format; refusing to draw the graph.",
            ));
        }
        nodes.push(Node {
            oid: oid.to_owned(),
            parents,
        });
    }
    Ok(nodes)
}

/// Reads the topology of the first `count` commits in display order, the
/// slice the graph is laid out over. Deliberately a separate, cheap call:
/// it carries no message bytes, so the prefix a deep page needs stays small
/// enough that the graph can never be the thing that trips the capture bound.
fn topology(directory: &Path, count: u64, target: Option<&str>) -> Result<Vec<Node>, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args([
        "log",
        "--no-color",
        "--topo-order",
        &format!("--format={TOPO_FORMAT}"),
        "-n",
        &count.to_string(),
    ]);
    if let Some(rev) = target {
        command.arg(rev);
    }
    command.arg("--");
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        LOG_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "history_truncated",
            "The commit graph exceeded the capture bound; no graph was drawn.",
        ));
    }
    if !output.status.success() {
        let detail = redact(&String::from_utf8_lossy(&output.stderr));
        let first_line = detail.lines().next().unwrap_or("").to_owned();
        return Err(ProbeError::new("history_page_failed", first_line));
    }
    parse_topology(&output.stdout)
}

/// One deterministic page of history. `--topo-order` keeps the sequence
/// stable for a fixed commit graph, and `--skip`/`-n` on the caller's
/// `start` cursor reproduces earlier pages byte for byte.
///
/// The graph is laid out over the whole prefix `[0, start + limit)` — not
/// over this page alone. In topological order a parent is always below its
/// child, so from one page's data there is no way to tell "the parent is
/// further down" from "a child is up in an earlier page"; the lanes that
/// cross into this page are only knowable from the commits above it. The
/// prefix is read with the cheap topology format and every row of the page
/// gets the graph the whole history implies, so paging never breaks a line.
pub fn page(
    directory: &Path,
    start: u64,
    target: Option<&str>,
    limit: u64,
) -> Result<HistoryPage, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args([
        "log",
        "--no-color",
        "-z",
        "--topo-order",
        &format!("--format={LOG_FORMAT}"),
        "-n",
        &limit.saturating_add(1).to_string(),
        "--skip",
        &start.to_string(),
    ]);
    if let Some(rev) = target {
        command.arg(rev);
    }
    command.arg("--");
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        LOG_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "history_truncated",
            "The history page exceeded the capture bound; nothing was parsed.",
        ));
    }
    if !output.status.success() {
        let detail = redact(&String::from_utf8_lossy(&output.stderr));
        let first_line = detail.lines().next().unwrap_or("").to_owned();
        return Err(ProbeError::new("history_page_failed", first_line));
    }
    let parse_start = Instant::now();
    // The graph is laid out first so `parse` can hand every commit the row
    // for its own index and refuse the page if the two reads disagree.
    let graph_start = parse_start;
    let nodes = topology(
        directory,
        start.saturating_add(limit).saturating_add(1),
        target,
    )?;
    let rows = assign_lanes(&nodes, MAX_LANES);
    let mut commits = parse(&output.stdout, &rows, start as usize)?;
    perf::mark("history.graph", graph_start.elapsed());
    perf::mark("history.parse", parse_start.elapsed());
    let has_more = commits.len() as u64 > limit;
    if has_more {
        commits.truncate(limit as usize);
    }
    Ok(HistoryPage {
        start,
        commits,
        has_more,
    })
}

/// Parses `diff-tree -z --name-status` output: alternating status and path
/// tokens, with rename/copy records carrying two paths (source first). The
/// stream ends with NUL, so exactly one trailing empty token is expected.
pub fn parse_files(bytes: &[u8]) -> Result<Vec<CommitFileView>, ProbeError> {
    fn malformed() -> ProbeError {
        ProbeError::new(
            "history_protocol_error",
            "Git returned a commit file list in an unexpected format; refusing to parse it.",
        )
    }
    let mut tokens = bytes.split(|b| *b == RECORD_SEP).peekable();
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            if tokens.peek().is_none() {
                break;
            }
            return Err(malformed());
        }
        let (kind, score) = status.split_first().expect("non-empty status");
        let two_paths = match kind {
            b'A' | b'D' | b'M' | b'T' | b'U' | b'X' | b'B' => {
                if !score.is_empty() {
                    return Err(malformed());
                }
                false
            }
            b'R' | b'C' => {
                if score.is_empty() || !score.iter().all(u8::is_ascii_digit) {
                    return Err(malformed());
                }
                true
            }
            _ => return Err(malformed()),
        };
        let first = tokens
            .next()
            .filter(|t| !t.is_empty())
            .ok_or_else(malformed)?;
        let (old_path, path) = if two_paths {
            let second = tokens
                .next()
                .filter(|t| !t.is_empty())
                .ok_or_else(malformed)?;
            (Some(crate::model::display_name(first)), second)
        } else {
            (None, first)
        };
        files.push(CommitFileView {
            status: lossy(status),
            path: crate::model::display_name(path),
            old_path,
        });
    }
    Ok(files)
}

/// Files changed by one commit. `--root` includes the initial commit,
/// `-M` surfaces renames, and first-parent diff semantics keep merges
/// readable: what the merge brought into the line it continued.
pub fn commit_files(directory: &Path, oid: &str) -> Result<Vec<CommitFileView>, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args([
        "diff-tree",
        "-r",
        "-z",
        "--no-commit-id",
        "--name-status",
        "-M",
        "--root",
        "--diff-merges=first-parent",
        oid,
        "--",
    ]);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        LOG_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "history_truncated",
            "The commit file list exceeded the capture bound; nothing was parsed.",
        ));
    }
    if !output.status.success() {
        let detail = redact(&String::from_utf8_lossy(&output.stderr));
        let first_line = detail.lines().next().unwrap_or("").to_owned();
        return Err(ProbeError::new("commit_files_failed", first_line));
    }
    parse_files(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn git(dir: &Path, args: &[&str]) {
        crate::repo::git_with(
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

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--quiet", "--initial-branch=main"]);
        (root, repo)
    }

    /// A stand-in graph for the parser tests, which are about the record
    /// protocol and not about lane assignment: one straight first-parent line,
    /// long enough that any `parse` call asking for a row gets one.
    fn plain_graph(rows: usize) -> Vec<GraphRow> {
        (0..rows)
            .map(|index| GraphRow {
                node: 0,
                entry: index > 0,
                exit: true,
                merge: false,
                root: index == 0,
                lanes: Vec::new(),
                branches: Vec::new(),
                incoming: Vec::new(),
                dangling: false,
                folded: false,
            })
            .collect()
    }

    fn commit(repo: &Path, message: &str) -> String {
        git(
            repo,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "--no-verify",
                "-m",
                message,
            ],
        );
        oid(repo, "HEAD")
    }

    fn oid(repo: &Path, rev: &str) -> String {
        let output = std::process::Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", rev])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("git");
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn multiline_messages_survive_the_protocol_byte_exact() {
        let (_root, repo) = fixture();
        // Includes a literal field separator, fake decoration-looking lines
        // and blank lines — none of which may split or truncate the record.
        let body = "subject line\nsecond \u{1f} separator line\nOn branch main\n\nlast line";
        git(
            &repo,
            &["commit", "-q", "--allow-empty", "--no-verify", "-m", body],
        );
        let page = page(&repo, 0, None, 10).unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].message, body);
        assert_eq!(page.commits[0].subject, "subject line");
        assert_eq!(page.commits[0].author_name, "guit test");
        assert!(page.commits[0].author_date.contains('T'));
        assert!(page.commits[0].refs.iter().any(|t| t.contains("main")));
    }

    #[test]
    fn pagination_walks_the_whole_history_without_gaps_or_overlap() {
        let (_root, repo) = fixture();
        let mut expected = Vec::new();
        for index in 0..7 {
            let oid = commit(&repo, &format!("c{index}"));
            expected.push(oid);
        }
        expected.reverse(); // newest first
        let mut collected = Vec::new();
        let mut start = 0;
        loop {
            let page = page(&repo, start, None, 3).unwrap();
            assert_eq!(page.start, start);
            collected.extend(page.commits.iter().map(|c| c.oid.clone()));
            if !page.has_more {
                break;
            }
            start += page.commits.len() as u64;
        }
        assert_eq!(collected, expected);
        // A second pass over the same cursor returns identical pages.
        let again = page(&repo, 3, None, 3).unwrap();
        assert_eq!(again.commits.len(), 3);
        assert_eq!(again.commits[0].oid, expected[3]);
    }

    #[test]
    fn merges_are_ordered_topologically_between_branch_and_mainline() {
        let (_root, repo) = fixture();
        let base = commit(&repo, "base");
        git(&repo, &["branch", "side"]);
        let main_line = commit(&repo, "on main");
        git(&repo, &["switch", "-q", "side"]);
        let side = commit(&repo, "on side");
        git(&repo, &["switch", "-q", "main"]);
        git(
            &repo,
            &["merge", "--no-ff", "-q", "-m", "the merge", "side"],
        );
        let page = page(&repo, 0, None, 10).unwrap();
        let order: Vec<&str> = page.commits.iter().map(|c| c.oid.as_str()).collect();
        let merge = &page.commits[0];
        assert_eq!(merge.subject, "the merge");
        assert_eq!(merge.parents, vec![main_line.clone(), side.clone()]);
        // Every commit appears after its parents in topo order.
        for (index, entry) in page.commits.iter().enumerate() {
            for parent in &entry.parents {
                let at = order.iter().position(|o| *o == parent).expect("parent");
                assert!(at > index, "parent listed before child");
            }
        }
        // The base commit is reachable and listed exactly once.
        assert_eq!(page.commits.iter().filter(|c| c.oid == base).count(), 1);
    }

    #[test]
    fn parsing_rejects_short_records_instead_of_guessing() {
        let broken = b"abc\x1fdef"; // fewer than FIELD_COUNT fields
        let error = parse(broken, &plain_graph(4), 0).unwrap_err();
        assert_eq!(error.code, "history_protocol_error");
        // Empty input and trailing separators parse to zero commits.
        assert_eq!(parse(&[], &plain_graph(4), 0).unwrap().len(), 0);
        assert_eq!(parse(b"\x00", &plain_graph(4), 0).unwrap().len(), 0);
    }

    #[test]
    fn a_row_without_a_graph_slot_is_refused_not_defaulted() {
        // A commit must never be drawn in a column nobody else agrees on: if
        // the graph ran out, the page is refused.
        let record = b"\x00".to_vec();
        let _ = record;
        let one = format!(
            "{}\x1f\x1fa\x1fa@b\x1f2026-01-01T00:00:00Z\x1fa\x1fa@b\x1f2026-01-01T00:00:00Z\x1f\x1fmsg\n\x00",
            "a".repeat(40)
        );
        assert_eq!(
            parse(one.as_bytes(), &[], 0).unwrap_err().code,
            "history_graph_mismatch"
        );
    }

    #[test]
    fn unknown_target_and_empty_repository_are_structured_failures() {
        let (_root, repo) = fixture();
        let error = page(
            &repo,
            0,
            Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
            10,
        )
        .unwrap_err();
        assert_eq!(error.code, "history_page_failed");
        assert!(!error.message.is_empty());
        // Unborn HEAD: the caller gates on the session branch state, the
        // raw page surfaces Git's refusal without pretending to be empty.
        let error = page(&repo, 0, None, 10).unwrap_err();
        assert_eq!(error.code, "history_page_failed");
    }

    #[test]
    fn oid_validation_admits_only_full_lowercase_hex() {
        assert!(valid_oid(&"a".repeat(40)));
        assert!(valid_oid(&"0123456789abcdef".repeat(4) /* 64 */));
        assert!(!valid_oid("HEAD"));
        assert!(!valid_oid(&"a".repeat(39)));
        assert!(!valid_oid(&"A".repeat(40)));
        assert!(!valid_oid(&format!("--{}", "a".repeat(38))));
        assert!(!valid_oid("refs/heads/main"));
        assert!(!valid_oid(&"z".repeat(40)));
    }

    #[test]
    fn decorations_carry_branches_tags_and_remotes() {
        let (_root, repo) = fixture();
        let oid = commit(&repo, "tagged");
        git(&repo, &["tag", "v1"]);
        git(&repo, &["branch", "keep"]);
        let page = page(&repo, 0, Some(&oid), 10).unwrap();
        let refs = &page.commits[0].refs;
        assert!(refs.iter().any(|t| t == "tag: v1"), "{refs:?}");
        assert!(refs.iter().any(|t| t.contains("main")), "{refs:?}");
        assert!(refs.iter().any(|t| t == "keep"), "{refs:?}");
    }

    fn touch(repo: &Path, name: &str, content: &str) {
        std::fs::write(repo.join(name), content).unwrap();
    }

    fn commit_worktree(repo: &Path, message: &str) -> String {
        git(repo, &["add", "--all"]);
        commit(repo, message);
        oid(repo, "HEAD")
    }

    #[test]
    fn file_listing_covers_root_adds_and_later_modifications() {
        let (_root, repo) = fixture();
        touch(&repo, "a.txt", "one\n");
        touch(&repo, "中文 文件.txt", "one\n");
        let root_commit = commit_worktree(&repo, "initial");
        let files = commit_files(&repo, &root_commit).unwrap();
        // `--root` makes the initial commit listable; order is Git's.
        let mut names: Vec<(&str, &str)> = files
            .iter()
            .map(|f| (f.status.as_str(), f.path.as_str()))
            .collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![("A", "a.txt"), ("A", "中文 文件.txt")],
            "--root must include the initial commit"
        );
        touch(&repo, "a.txt", "two\n");
        let second = commit_worktree(&repo, "modify");
        let files = commit_files(&repo, &second).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            (files[0].status.as_str(), files[0].path.as_str()),
            ("M", "a.txt")
        );
        assert_eq!(files[0].old_path, None);
    }

    #[test]
    fn rename_records_carry_both_paths() {
        let (_root, repo) = fixture();
        touch(&repo, "old name.txt", "one\n");
        commit_worktree(&repo, "before rename");
        git(&repo, &["mv", "old name.txt", "新名.txt"]);
        let renamed = commit_worktree(&repo, "rename");
        let files = commit_files(&repo, &renamed).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "新名.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old name.txt"));
        assert_eq!(
            files[0].status, "R100",
            "score stays attached to the status token"
        );
    }

    #[test]
    fn merge_listing_shows_only_the_first_parent_difference() {
        let (_root, repo) = fixture();
        touch(&repo, "base.txt", "one\n");
        commit_worktree(&repo, "base");
        git(&repo, &["switch", "-q", "-c", "side"]);
        touch(&repo, "side.txt", "side\n");
        commit_worktree(&repo, "side work");
        git(&repo, &["switch", "-q", "main"]);
        touch(&repo, "main.txt", "main\n");
        commit_worktree(&repo, "main work");
        git(
            &repo,
            &["merge", "--no-ff", "-q", "-m", "the merge", "side"],
        );
        let merge = oid(&repo, "HEAD");
        let files = commit_files(&repo, &merge).unwrap();
        // Against the first parent (the mainline), only the merged-in file
        // is new; main.txt was already there and base.txt is unchanged.
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["side.txt"]);
    }

    #[test]
    fn unknown_commit_is_a_structured_failure() {
        let (_root, repo) = fixture();
        touch(&repo, "a.txt", "one\n");
        commit_worktree(&repo, "only");
        let error = commit_files(&repo, &"f".repeat(40)).unwrap_err();
        assert_eq!(error.code, "commit_files_failed");
        assert!(!error.message.is_empty());
    }

    #[test]
    fn parse_files_rejects_malformed_streams_instead_of_guessing() {
        assert!(parse_files(&[]).unwrap().is_empty());
        // A bare NUL is not a stream diff-tree can produce: records always
        // pair a status with at least one path.
        assert_eq!(
            parse_files(b"\x00").unwrap_err().code,
            "history_protocol_error"
        );
        let one = parse_files(b"M\x00a.txt\x00").unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(
            (one[0].status.as_str(), one[0].path.as_str()),
            ("M", "a.txt")
        );
        for broken in [
            &b"M\x00"[..],               // status without a path
            &b"R100\x00from\x00"[..],    // rename missing its new path
            &b"\x00\x00file"[..],        // empty token mid-stream
            &b"Mbogus\x00a.txt\x00"[..], // modifiers only exist for R/C
            &b"Q\x00a.txt\x00"[..],      // unknown status letter
            &b"M\x00\x00a"[..],          // empty path token
        ] {
            let error = parse_files(broken).unwrap_err();
            assert_eq!(error.code, "history_protocol_error", "input: {broken:?}");
        }
    }

    // --- the commit graph -------------------------------------------------

    fn oid_of(tag: &str) -> String {
        // A 40-hex id derived from the tag, so a hand-built graph never has
        // to invent a real object id to be structurally valid.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in tag.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        format!("{hash:040x}")
    }

    fn node(tag: &str, parents: &[&str]) -> Node {
        Node {
            oid: oid_of(tag),
            parents: parents.iter().map(|parent| oid_of(parent)).collect(),
        }
    }

    /// The rows a page starting at `start` would receive, derived the way
    /// `page` derives them: assign over the prefix, hand back the window.
    /// Kept next to the real thing so the boundary test exercises the same
    /// relationship without needing a repository.
    fn rows_for_page(nodes: &[Node], start: usize, max_lanes: u8) -> Vec<GraphRow> {
        let rows = assign_lanes(nodes, max_lanes);
        rows.into_iter().skip(start).collect()
    }

    /// base - m1..m6 (main) plus s1,s2 (side) merged back in as `merge`.
    fn branched_history() -> Vec<Node> {
        vec![
            node("m8", &["m7"]),
            node("m7", &["merge"]),
            node("merge", &["m6", "s2"]),
            node("s2", &["s1"]),
            node("s1", &["base"]),
            node("m6", &["m5"]),
            node("m5", &["m4"]),
            node("m4", &["m3"]),
            node("m3", &["m2"]),
            node("m2", &["m1"]),
            node("m1", &["base"]),
            node("base", &[]),
        ]
    }

    #[test]
    fn a_straight_history_is_one_lane_with_a_single_entry_and_a_root() {
        let nodes: Vec<Node> = (0..4)
            .rev()
            .map(|index| {
                if index == 0 {
                    node("c0", &[])
                } else {
                    node(&format!("c{index}"), &[&format!("c{}", index - 1)])
                }
            })
            .collect();
        let rows = assign_lanes(&nodes, MAX_LANES);
        assert_eq!(rows.len(), 4);
        for (index, row) in rows.iter().enumerate() {
            assert_eq!(row.node, 0, "the mainline never leaves column 0");
            assert_eq!(row.entry, index > 0, "row {index}");
            assert!(!row.merge && !row.folded);
            assert!(row.lanes.is_empty() && row.branches.is_empty());
        }
        assert!(rows[3].root, "the oldest commit is the root");
        assert!(!rows[3].exit, "a root has nothing below it");
        assert!(rows[0].exit, "every non-root leaves a line downward");
    }

    #[test]
    fn a_merge_keeps_the_mainline_straight_and_flows_the_branch_rightward() {
        let nodes = branched_history();
        let rows = assign_lanes(&nodes, MAX_LANES);
        let merge = &rows[2];
        assert!(merge.merge);
        assert_eq!(merge.node, 0, "the merge sits on the mainline column");
        assert_eq!(merge.exit, true, "its first parent continues downward");
        assert_eq!(
            merge.branches,
            vec![1],
            "the second parent opens exactly one lane to the right"
        );
        // The side branch occupies column 1 and receives a line from above.
        let s2 = &rows[3];
        assert_eq!(s2.node, 1);
        assert!(s2.entry, "the merge's edge arrives from above");
        // While the side lane is open, the mainline runs beside it.
        assert!(rows[4].lanes.contains(&0), "mainline crosses the side row");
        // Both lanes close out at the shared root: the side lane was carrying
        // it too, so it ends there rather than running past the last commit.
        assert!(rows[11].root);
        assert_eq!(
            rows[11].incoming,
            vec![1],
            "the side lane folds into the root"
        );
        assert!(rows[11].lanes.is_empty(), "nothing runs below the root");
    }

    #[test]
    fn an_octopus_merge_opens_one_lane_per_extra_parent() {
        let nodes = vec![
            node("top", &["octopus"]),
            node("octopus", &["main", "a", "b", "c"]),
            node("main", &["base"]),
            node("a", &["base"]),
            node("b", &["base"]),
            node("c", &["base"]),
            node("base", &[]),
        ];
        let rows = assign_lanes(&nodes, MAX_LANES);
        let octopus = &rows[1];
        assert!(octopus.merge);
        assert_eq!(
            octopus.branches,
            vec![1, 2, 3],
            "three extra parents open three ascending lanes"
        );
        assert_eq!(rows[2].node, 0, "the first parent keeps column 0");
        for (offset, column) in [1usize, 2, 3].iter().enumerate() {
            assert_eq!(rows[3 + offset].node, *column as u8);
            assert!(rows[3 + offset].entry, "each branch is entered from above");
        }
    }

    #[test]
    fn a_parent_below_the_window_is_reported_as_dangling_not_ended() {
        // `b` is the last commit of the loaded window, so its parent is below
        // it. The line has to say it continues rather than stop. `a`'s parent
        // is `b`, which is inside the window, so that line does continue into
        // a commit the user can see.
        let nodes = vec![node("a", &["b"]), node("b", &["c"])];
        let rows = assign_lanes(&nodes, MAX_LANES);
        assert!(!rows[0].dangling, "a's parent is the next row down");
        assert!(rows[1].dangling, "b's parent is not in the window");
        // Add the missing parent: it is now inside the window, so no line
        // leaves the loaded range.
        let mut full = nodes.clone();
        full.push(node("c", &[]));
        let rows = assign_lanes(&full, MAX_LANES);
        assert!(!rows[0].dangling);
        assert!(!rows[1].dangling);
        assert!(rows[2].root);
    }

    #[test]
    fn the_page_boundary_never_breaks_a_line() {
        // The invariant the whole design rests on: laying out page 2 on its
        // own data, given the rows for the prefix above it, must equal
        // slicing the rows for the whole history. If this drifts, a line
        // jumps columns the moment the user clicks "Load older".
        let nodes = branched_history();
        let whole = assign_lanes(&nodes, MAX_LANES);
        for split in 1..nodes.len() {
            let page = rows_for_page(&nodes[..], split, MAX_LANES);
            for (offset, row) in page.iter().enumerate() {
                assert_eq!(
                    row,
                    &whole[split + offset],
                    "row {offset} of the page starting at {split} disagrees with the whole"
                );
            }
        }
    }

    #[test]
    fn branches_that_share_one_parent_fold_into_it_and_close() {
        // Every topic branch cut from one base gives that base several
        // children, so the base waits in several lanes at once. It is drawn
        // once and the other lanes end on its row; a lane left holding a
        // commit that is already drawn would run down the gutter forever.
        let nodes = vec![
            node("top", &["fork"]),
            node("fork", &["a", "b", "c", "main"]),
            node("a", &["base"]),
            node("b", &["base"]),
            node("c", &["base"]),
            node("main", &["base"]),
            node("base", &[]),
        ];
        let rows = assign_lanes(&nodes, MAX_LANES);
        let base = &rows[6];
        assert_eq!(
            base.node, 0,
            "the shared parent is drawn in the leftmost lane"
        );
        assert!(base.root);
        assert_eq!(
            base.incoming,
            vec![1, 2, 3],
            "the lanes that were carrying it converge here"
        );
        assert!(
            base.lanes.is_empty(),
            "no lane is left running below the last commit"
        );
        // Every lane in the drawing is released by the time the root is drawn.
        for row in &rows {
            for lane in row.lanes.iter().chain(row.branches.iter()) {
                assert!(
                    *lane < 4,
                    "a lane outlived the gutter it was assigned in: {row:?}"
                );
            }
        }
    }

    #[test]
    fn the_last_row_never_leaves_a_lane_running() {
        // The invariant the convergence bug broke, stated over a history with
        // several shared parents in it: the oldest commit closes every lane.
        let nodes = branched_history();
        let rows = assign_lanes(&nodes, MAX_LANES);
        let last = rows.last().expect("a history");
        assert!(last.root, "the oldest commit has no parent");
        assert!(
            last.lanes.is_empty(),
            "the last row carries no lane: {last:?}"
        );
        assert!(!last.exit, "nothing leaves the bottom of the history");
    }

    #[test]
    fn a_window_too_wide_to_draw_folds_and_says_so() {
        // More live lanes than the gutter can hold: the graph must be
        // reported as folded rather than drawn into columns that collide.
        let mut nodes = vec![node("top", &["fork"])];
        // A wide fan of branches all open at once.
        let fan: Vec<String> = (0..(MAX_LANES as usize + 4))
            .map(|index| format!("b{index}"))
            .collect();
        let fan_refs: Vec<&str> = fan.iter().map(String::as_str).collect();
        nodes.push(node("fork", &fan_refs));
        for branch in &fan {
            nodes.push(node(branch, &["base"]));
        }
        nodes.push(node("base", &[]));
        let rows = assign_lanes(&nodes, MAX_LANES);
        assert!(
            rows.iter().all(|row| row.folded),
            "an over-wide graph folds"
        );
        // Folded, the mainline is still continuous and nothing collides.
        assert!(rows.iter().all(|row| row.node == 0));
        assert!(rows.iter().all(|row| row.lanes.is_empty()));
    }

    #[test]
    fn assignment_is_deterministic_so_a_lane_keeps_its_column() {
        let nodes = branched_history();
        let first = assign_lanes(&nodes, MAX_LANES);
        let second = assign_lanes(&nodes, MAX_LANES);
        assert_eq!(first, second, "the same history always draws the same way");
    }

    #[test]
    fn topology_parsing_refuses_anything_that_is_not_oid_and_parents() {
        let good = format!("{} {}\n", oid_of("a"), oid_of("b"));
        let nodes = parse_topology(good.as_bytes()).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].parents, vec![oid_of("b")]);

        // A root commit has no parents and still parses.
        let root = format!("{}\n", oid_of("a"));
        assert!(parse_topology(root.as_bytes()).unwrap()[0]
            .parents
            .is_empty());

        for broken in [
            "HEAD main\n",                    // not an object id
            &format!("{}\n", "A".repeat(40)), // uppercase is not a git oid
            &format!("{} notanoid\n", oid_of("a")),
            &format!("{} {} extra\n", oid_of("a"), oid_of("b")),
        ] {
            assert_eq!(
                parse_topology(broken.as_bytes()).unwrap_err().code,
                "history_protocol_error",
                "input: {broken:?}"
            );
        }
    }
}
