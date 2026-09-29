use crate::perf;
use crate::probe::{redact, ProbeError};
use crate::session::ReadContext;
use crate::{repo, runner};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Field separator inside one log record (ASCII unit separator).
const FIELD_SEP: u8 = 0x1f;
/// Record separator emitted by `git log -z` (NUL). Git itself refuses to
/// create a commit whose message contains NUL ("a NUL byte in commit log
/// message not allowed"), so NUL is a reliable entry boundary; `%x1f` can
/// appear inside messages, which is why the message is the final field and
/// records are split with a field-count limit.
const RECORD_SEP: u8 = 0x00;
const FIELD_COUNT: usize = 9;
// No decoration field: which names sit on a commit is a fact about the
// repository's references, read and invalidated with them (`refs.rs`) rather
// than frozen into whatever the refs happened to be called when this page was
// laid out.
const LOG_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B";
/// Topology-only format for the graph prefix. Oid + parents is ~82 bytes a
/// commit, so a ten-thousand-commit prefix stays far under the capture bound
/// and cannot trip `history_truncated`. Only the parents are ever needed to
/// assign lanes, so this cheaper format is what the prefix route reads: a page
/// that continues a remembered boundary takes its parents out of its own
/// records instead, and starts no second process at all.
const TOPO_FORMAT: &str = "%H %P";
/// 100 commits with long messages can exceed the default capture bound.
const LOG_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
/// A graph column, counted by the layout and carried by a row. The type is the
/// wire shape, so a column that does not fit it is a column no renderer could
/// be shown: raising `MAX_LANES` past it is a type error rather than a number
/// that quietly wraps back to a lane that is already drawn.
pub type Lane = u8;
/// The gutter has room for this many lanes. A repository whose live lane
/// count would exceed it is drawn first-parent and says so, rather than
/// drawing lanes the gutter cannot hold.
pub const MAX_LANES: Lane = 24;
pub const PAGE_SIZE: u64 = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    pub node: Lane,
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
    pub lanes: Vec<Lane>,
    /// Extra parent lanes that begin at this node, ascending. Each is drawn
    /// sideways from the node, then down.
    pub branches: Vec<Lane>,
    /// Lanes that were carrying this same commit and stop here, ascending.
    /// Several branches commonly share one parent — every topic branch cut
    /// from the same base does — and those lanes all arrive at this one row
    /// rather than running past it.
    pub incoming: Vec<Lane>,
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

/// What one window of the graph leaves for the window below it: the lanes
/// still open at its bottom edge, how wide the gutter ever got, and the row it
/// stops at.
///
/// This is the entire cross-page state, and its width is a function of the lane
/// cap rather than of the repository. Two things hold it there: a free column
/// is kept as `None`, so what the next page inherits is the numbering the layout
/// gave and not a compaction of it, and a column is only ever *added* when
/// every column at or right of the new branch is occupied — which means an
/// unfolded window leaves at most twice the cap, since the columns it filled
/// are the peak and the ones below the node are fewer than the node's own
/// column plus one. `past_the_lane_cap_keeps_the_inherited_state_small` is that
/// claim as a test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    /// The row this state stops before: the only page that may continue it is
    /// the one starting here.
    next_start: u64,
    lanes: Vec<Option<String>>,
    /// The widest any window has been, carried forward so the fold decision
    /// stays about the whole history rather than about the page in hand.
    peak: usize,
    /// The history is past the cap, so the lanes are dropped and only the fold
    /// carries. A folded row is drawn from its own commit and its own window,
    /// and every later page folds too — `peak` only ever grows.
    folded: bool,
}

impl Edge {
    /// The edge above the first page: nothing is open above it, and no window
    /// has been wide yet.
    fn at_top() -> Edge {
        Edge {
            next_start: 0,
            lanes: Vec::new(),
            peak: 0,
            folded: false,
        }
    }

    /// True when `oid` is a commit this edge left a lane open for.
    ///
    /// Every commit except the head has a child somewhere above it, and that
    /// child is what parked it in a lane, so a page whose top row nobody is
    /// waiting for is not the page this edge was drawn from.
    fn expects(&self, oid: &str) -> bool {
        self.lanes.iter().flatten().any(|lane| lane == oid)
    }
}

/// The rows for one window, and the lanes its shown rows leave at the bottom.
///
/// `shown` is how many of `nodes` the page renders. A window is normally one row
/// longer, because whether the last drawn line ends or runs off the bottom of the
/// list is a fact about the commit *below* it, and that row is read and laid out
/// for no other reason — it is drawn again, correctly, by the page below. The cut
/// is what makes the two routes meet: the edge stops at the last row the page
/// shows, which is the cursor the next page asks with, while the rows are laid
/// out over the whole window.
///
/// With no edge the window *is* the whole history above it, which is what the
/// prefix read hands back; with one, the window is the page alone and inherits
/// the only fact a page cannot see for itself — which of its commits are already
/// being waited for by the rows above. `the_edge_continues_where_the_prefix_read_agrees`
/// pins that the two routes draw the same rows.
pub fn assign_edge(
    edge: Option<&Edge>,
    nodes: &[Node],
    shown: usize,
    max_lanes: Lane,
    follow_all: bool,
) -> (Vec<GraphRow>, Edge) {
    let present: std::collections::HashSet<&str> =
        nodes.iter().map(|node| node.oid.as_str()).collect();
    let empty = Edge::at_top();
    let edge = edge.unwrap_or(&empty);
    // An edge stops where its rows stop: a page that ran out of history has no
    // boundary below the last commit in it.
    let shown = shown.min(nodes.len());
    let next_start = edge.next_start.saturating_add(shown as u64);
    if edge.folded {
        return (
            fold_window(nodes, &present),
            Edge {
                next_start,
                lanes: Vec::new(),
                peak: edge.peak,
                folded: true,
            },
        );
    }
    let (slots, window_peak, lanes) = layout(nodes, &present, follow_all, &edge.lanes, shown);
    // The peak is history-wide, so a fan two pages above still folds the page
    // here: the alternative is a graph that changes what it claims to be too
    // short for, page by page, as the user scrolls.
    let peak = edge.peak.max(window_peak);
    if follow_all && peak > usize::from(max_lanes) {
        return (
            fold_window(nodes, &present),
            Edge {
                next_start,
                lanes: Vec::new(),
                peak,
                folded: true,
            },
        );
    }
    // The cap above is stated in the same type a column ships in, so a column
    // that cannot be represented is already past it. `ship` re-checks that
    // rather than trusting the arithmetic: a row whose column did not fit would
    // be drawn in a lane that another commit already owns, which is a wrong
    // graph, while folding is a shorter graph that says it is shorter.
    match ship(slots) {
        Some(rows) => (
            rows,
            Edge {
                next_start,
                lanes,
                peak,
                folded: false,
            },
        ),
        None => (
            fold_window(nodes, &present),
            Edge {
                next_start,
                lanes: Vec::new(),
                peak,
                folded: true,
            },
        ),
    }
}

fn fold_window(nodes: &[Node], present: &std::collections::HashSet<&str>) -> Vec<GraphRow> {
    nodes.iter().map(|node| folded_row(node, present)).collect()
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
    for (column, slot) in owner.iter().enumerate().skip(from) {
        if slot.is_none() {
            return column;
        }
    }
    owner.push(None);
    owner.len() - 1
}

/// A row mid-layout: every fact a `GraphRow` carries, with the columns still
/// in the width the counter uses. Converting them into the width a row ships
/// in happens once, in `ship`.
#[derive(Debug, Clone)]
struct Slot {
    node: usize,
    entry: bool,
    exit: bool,
    merge: bool,
    root: bool,
    lanes: Vec<usize>,
    branches: Vec<usize>,
    incoming: Vec<usize>,
    dangling: bool,
}

/// Assigns lanes and reports how many columns were ever live at once, along
/// with the columns left open at the bottom edge. The width is measured from
/// the same pass that draws, so the fold decision can never be made against a
/// different algorithm than the one that renders.
///
/// `seed` is the lane state of the window above, in column order: the layout
/// continues those lanes instead of starting empty, which is what lets a page
/// be drawn from its own rows. The first page of a history passes none.
fn layout(
    nodes: &[Node],
    present: &std::collections::HashSet<&str>,
    follow_all: bool,
    seed: &[Option<String>],
    shown: usize,
) -> (Vec<Slot>, usize, Vec<Option<String>>) {
    let mut owner: Vec<Option<&str>> = seed.iter().map(|lane| lane.as_deref()).collect();
    // The columns as they stand at the bottom of the rows the page shows. A
    // window may run one row past that, so the end of the loop is not the place
    // the next page continues from; this is.
    let mut boundary: Vec<Option<String>> = seed.to_vec();
    let mut rows = Vec::with_capacity(nodes.len());
    let mut peak = 0usize;
    for (index, node) in nodes.iter().enumerate() {
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
        let incoming: Vec<usize> = held.iter().skip(1).copied().collect();
        let mut branches = Vec::new();
        let mut exit = false;
        for (index, parent) in node.parents.iter().enumerate() {
            if index == 0 {
                owner[column] = Some(parent);
                exit = true;
            } else if follow_all {
                let branch = take_free(&mut owner, column + 1);
                owner[branch] = Some(parent);
                branches.push(branch);
            }
            // A parent past the first stays in the commit's own parent list, so
            // `merge` below remains honest; it is simply not followed into a
            // lane when the view asked for the mainline alone.
        }
        peak = peak.max(owner.iter().filter(|waiting| waiting.is_some()).count());
        let lanes = (0..owner.len())
            .filter(|other| *other != column && owner[*other].is_some())
            .collect();
        rows.push(Slot {
            node: column,
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
                .take(if follow_all { usize::MAX } else { 1 })
                .any(|parent| !present.contains(parent.as_str())),
        });
        // Owned by the time they leave, because the window that made them is about
        // to be dropped and the lanes it left open are not.
        if index + 1 == shown {
            boundary = owner.iter().map(|lane| lane.map(str::to_owned)).collect();
        }
    }
    (rows, peak, boundary)
}

fn lane_columns(values: &[usize]) -> Option<Vec<Lane>> {
    values
        .iter()
        .map(|value| Lane::try_from(*value).ok())
        .collect()
}

/// Narrows the layout's columns to the width a row is carried in. `None` says
/// some column was too large for it, which the caller answers by folding: a
/// column that wrapped would be drawn in a lane another commit already owns.
fn ship(slots: Vec<Slot>) -> Option<Vec<GraphRow>> {
    let mut rows = Vec::with_capacity(slots.len());
    for slot in slots {
        rows.push(GraphRow {
            node: Lane::try_from(slot.node).ok()?,
            entry: slot.entry,
            exit: slot.exit,
            merge: slot.merge,
            root: slot.root,
            lanes: lane_columns(&slot.lanes)?,
            branches: lane_columns(&slot.branches)?,
            incoming: lane_columns(&slot.incoming)?,
            dangling: slot.dangling,
            folded: false,
        });
    }
    Some(rows)
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

/// Splits one record of the `-z` stream into `LOG_FORMAT`'s fields.
///
/// `None` says the record is not that shape. Both readers of the same bytes ask
/// through here, so they cannot drift into reading different things out of one
/// page: the message is the last field and `%B` may contain `%x1f`, which is
/// why the split is capped at the field count rather than open-ended.
fn split_fields(record: &[u8]) -> Option<Vec<&[u8]>> {
    let fields: Vec<&[u8]> = record
        .splitn(FIELD_COUNT, |byte| *byte == FIELD_SEP)
        .collect();
    if fields.len() != FIELD_COUNT {
        return None;
    }
    Some(fields)
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
///
/// `nodes` must be the topology those rows were assigned from — the same read,
/// the same window. The rows say where a commit is drawn; only the nodes say
/// *what* is drawn at that position, and a page has to be about one history:
/// see the check under the loop.
pub fn parse(
    bytes: &[u8],
    nodes: &[Node],
    graph: &[GraphRow],
    start: usize,
) -> Result<Vec<CommitView>, ProbeError> {
    let mismatch = || {
        // Named once so every shape of disagreement answers with the same
        // sentence: the code can see that the two reads are not describing one
        // history, but not which of them moved, so it does not claim to.
        ProbeError::new(
            "history_graph_mismatch",
            "The commit list and the graph did not describe the same history; the page was refused.",
        )
    };
    let mut commits = Vec::new();
    for record in bytes.split(|b| *b == RECORD_SEP) {
        if record.is_empty() {
            continue;
        }
        let Some(fields) = split_fields(record) else {
            // Never guess around a partial record: a wrong field could be
            // rendered as a commit message or, worse, fed back as an argument.
            return Err(ProbeError::new(
                "history_protocol_error",
                "Git returned history in an unexpected format; refusing to parse it.",
            ));
        };
        let message = {
            let raw = fields[8];
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
        let oid = lossy(fields[0]);
        let parents: Vec<String> = lossy(fields[1])
            .split(' ')
            .filter(|parent| !parent.is_empty())
            .map(str::to_owned)
            .collect();
        let row = graph.get(offset).ok_or_else(mismatch)?;
        // Having a slot is not the same claim as this commit owning it. Both
        // reads are asked for one pinned commit, so a pair of histories of the
        // same length used to pass straight through here: the row would be
        // drawn from a commit the topology read never saw at that position.
        let node = nodes.get(offset).ok_or_else(mismatch)?;
        if node.oid != oid || node.parents != parents {
            return Err(mismatch());
        }
        commits.push(CommitView {
            oid,
            parents,
            subject,
            author_name: lossy(fields[2]),
            author_email: lossy(fields[3]),
            author_date: lossy(fields[4]),
            committer_name: lossy(fields[5]),
            commit_date: lossy(fields[7]),
            message,
            graph: row.clone(),
        });
    }
    Ok(commits)
}

/// Reads the topology of the page's own records: `%H` and `%P` are the first
/// two fields of `LOG_FORMAT`, so the rows a page lists carry the parents the
/// graph needs, and a page continued from an [`Edge`] needs no second process.
///
/// This is the same bytes `parse` reads, split by the same function, and the
/// page is still refused when the two do not agree on what sits at an index:
/// the check under `parse`'s loop compares every commit against the node the
/// graph was laid out from.
fn page_topology(bytes: &[u8]) -> Result<Vec<Node>, ProbeError> {
    let malformed = || {
        ProbeError::new(
            "history_protocol_error",
            "Git returned history in an unexpected format; refusing to parse it.",
        )
    };
    let mut nodes = Vec::new();
    for record in bytes.split(|b| *b == RECORD_SEP) {
        if record.is_empty() {
            continue;
        }
        let fields = split_fields(record).ok_or_else(malformed)?;
        let oid = lossy(fields[0]);
        let parents: Vec<String> = lossy(fields[1])
            .split(' ')
            .filter(|parent| !parent.is_empty())
            .map(str::to_owned)
            .collect();
        // An id that is not a full object id cannot be matched against the lanes
        // inherited from the page above, so it is refused rather than parked.
        if !valid_oid(&oid) || parents.iter().any(|parent| !valid_oid(parent)) {
            return Err(malformed());
        }
        nodes.push(Node { oid, parents });
    }
    Ok(nodes)
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
/// slice the graph is laid out over. This is the authority a page falls back to
/// when there is no [`Edge`] to continue: it re-derives every lane from the
/// whole history above the window, which is what the remembered edge claims to
/// have already settled.
///
/// Not a cheap call, and the reason is `--topo-order`: Git orders every
/// reachable commit before it emits the first row, so `-n` bounds the output
/// and never the work. The read therefore costs the same at every depth, and
/// what sets its price is the size of the repository — except in a repository
/// that has a commit-graph file, where Git has generation numbers to order
/// with instead of the walk. Nine of this host's repositories carry no such
/// file and two of them never can — they are shallow clones, and Git writes no
/// graph for one — so this read is the ordinary cost of a page rather than an
/// exceptional one. It carries 83 bytes a node and no message bytes, so on a
/// page deep enough it, not the page read, is what trips the capture bound.
///
/// `target` is required and is the commit the page's other read was asked for:
/// a revspec here would be resolved a second time, in a second process, and the
/// two answers are then free to be about different histories.
fn topology(
    directory: &Path,
    count: u64,
    target: &str,
    first_parent: bool,
) -> Result<Vec<Node>, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args([
        "log",
        "--no-color",
        "--topo-order",
        &format!("--format={TOPO_FORMAT}"),
        "-n",
        &count.to_string(),
    ]);
    if first_parent {
        command.arg("--first-parent");
    }
    command.arg(target);
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

/// The commit a page is read from, as one full object id.
///
/// A page asks Git once and may ask twice, and every answer is about one
/// history only if all of them name the same commit — including the remembered
/// page boundary, which is a claim about a history rather than a read of one.
/// So the revspec is resolved — or taken from the caller, who is holding the
/// commit the session was published with — and both reads then name that object.
/// `None` means nobody said which: only a repository whose snapshot reports no
/// branch at all (a bare one, where Git refuses to report a status) arrives
/// here with nothing pinned, and this is where it pays for the one extra read
/// the session could answer for free.
///
/// A commit id, not a branch name, is also what makes a page reproducible: the
/// branch a page was read from can move while the page is on screen, and a graph
/// drawn from the name would then be a graph of whatever the name reached.
/// It is what makes a remembered boundary checkable too, for the same reason.
fn pinned_rev(directory: &Path, target: Option<&str>) -> Result<String, ProbeError> {
    if let Some(rev) = target {
        // Checked here as well as at the command layer: this string is about to
        // become an argument to Git, and the module that runs the command owns
        // what its argv accepts. Anything that is not a full object id — a
        // revspec, an option, a path — never reaches the process.
        if !valid_oid(rev) {
            return Err(ProbeError::new(
                "history_target_invalid",
                "History can only be requested for a full commit id from the current view.",
            ));
        }
        return Ok(rev.to_owned());
    }
    let mut command = repo::user_git_command(directory);
    command.args(["rev-parse", "--verify", "HEAD"]);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        LOG_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if !output.status.success() {
        // Git's own words here are about a branch that has no commits, and that
        // is a fact a snapshot can answer better than a stderr line: an unborn
        // session is gated by the command layer and never reaches this read. What
        // is left is a HEAD that names no commit for a reason this read cannot
        // see, which is reported as a failed read rather than as a history with
        // nothing in it.
        return Err(ProbeError::new(
            "history_head_unresolved",
            "This repository's HEAD names no commit, so no history was read.",
        ));
    }
    // Truncation needs no branch of its own: an answer cut short is not a
    // complete object id, and the check below refuses it.
    let rev = lossy(output.stdout.trim_ascii()).trim().to_owned();
    if !valid_oid(&rev) {
        return Err(ProbeError::new(
            "history_protocol_error",
            "Git did not answer with a single commit id; refusing to read a history from it.",
        ));
    }
    Ok(rev)
}

/// The one boundary guit remembers, with the exact terms it was earned on.
#[derive(Debug, Clone)]
struct Boundary {
    /// The session and graph generation the pages above were read under. A
    /// boundary is a claim about a history, and only this pair says which
    /// session's history it is a claim about — two clones of one project share
    /// every object id and differ in how far their copy reaches.
    context: ReadContext,
    /// The commit both reads were asked about. A page for a different commit is
    /// a different history even inside one session.
    rev: String,
    first_parent: bool,
    edge: Edge,
}

/// The graph state carried from one page to the next.
///
/// One boundary, not a table: the panel pages forward from the page it just
/// drew, so the state that saves a re-read is always the state at the bottom of
/// the newest window, and a second one would only ever be a guess about where
/// the user means to click. Its size is fixed by the lane cap on [`Edge`], so
/// neither the depth of a page nor the size of a repository can grow it, and an
/// answer that does not match the request is no answer at all: the caller reads
/// the prefix, which is correct at any depth and is what this saves.
#[derive(Debug, Default)]
pub struct GraphCache {
    held: Mutex<Option<Boundary>>,
}

impl GraphCache {
    /// The edge a page starting at `start` may continue, if the remembered
    /// boundary is about this context, this commit and this view, and stops
    /// exactly where the page begins.
    fn continue_from(
        &self,
        context: ReadContext,
        rev: &str,
        first_parent: bool,
        start: u64,
    ) -> Option<Edge> {
        let held = crate::util::guard(&self.held);
        let boundary = held.as_ref()?;
        if boundary.context != context
            || boundary.rev != rev
            || boundary.first_parent != first_parent
        {
            return None;
        }
        (boundary.edge.next_start == start).then(|| boundary.edge.clone())
    }

    /// Remembers the edge this window left, under the terms it was earned on.
    ///
    /// Later, not atomic with the read it follows: two pages of one history can
    /// be in flight, and whichever writes last is the one the next request is
    /// measured against. A page that finds a boundary from its own side of the
    /// history is not wrong, it is a miss, and a miss is the read this cache
    /// exists to avoid rather than a graph drawn badly.
    fn advance(&self, context: ReadContext, rev: &str, first_parent: bool, edge: Edge) {
        *crate::util::guard(&self.held) = Some(Boundary {
            context,
            rev: rev.to_owned(),
            first_parent,
            edge,
        });
    }

    /// Forgets the boundary. Called when the session it was read from closes;
    /// a boundary from a dead session can never match a live context, so this
    /// is about not holding a few kilobytes of object ids for a repository that
    /// is no longer on screen.
    pub fn clear(&self) {
        *crate::util::guard(&self.held) = None;
    }
}

/// The nodes and the rows for one window of history, and where this page's first
/// row sits inside them.
///
/// Two routes here, and the difference between them is a Git process. A page
/// that continues a remembered [`Edge`] takes its topology from its own records
/// — `%P` is the second field of `LOG_FORMAT`, so the parents were already in
/// the bytes the page was read for — and lays them out from the lanes the page
/// above left open; its rows start at index `0`. Without a boundary to continue,
/// the whole prefix is read and laid out again — which is what the edge claims to
/// have settled once — and the page's rows start at `start`, below the rows above
/// it that were laid out in the same pass but belong to earlier pages. The caller
/// cannot tell the two apart from the cursor, so the index travels with them.
///
/// The edge is trusted only while it says it stops at this page's first row and
/// that row is a commit the edge is waiting for; see the witness under the first
/// branch. Both routes then hand on the edge the window leaves.
// The arguments are one page read, named field by field: the bytes the page came
// back with, where the page sits in the history, which history it is a page of,
// and which cache says what the pages above it settled. A bundle would be a
// second name for the same list, asked by nothing else.
#[allow(clippy::too_many_arguments)]
fn window(
    directory: &Path,
    bytes: &[u8],
    start: u64,
    limit: u64,
    rev: &str,
    first_parent: bool,
    context: ReadContext,
    cache: &GraphCache,
) -> Result<(Vec<Node>, Vec<GraphRow>, usize), ProbeError> {
    let follow_all = !first_parent;
    let graph_start = Instant::now();
    if let Some(edge) = cache.continue_from(context, rev, first_parent, start) {
        let nodes = page_topology(bytes)?;
        // The witness that the two are still one walk: in topological order
        // every commit but the head has a child above it, and that child is
        // what parked it in a lane, so the row at the top of a continued page
        // must be one the edge left open. A row nobody is waiting for is either
        // a different history or the same history re-ordered underneath a
        // pinned commit that did not move — a deepened shallow clone, restored
        // objects — and this edge is not authority over either. Falling through
        // to the prefix read is the answer, not a refusal.
        //
        // A folded edge asks for nothing, so there is no line to join wrongly:
        // it carries the fold, which is a claim about how wide this pinned
        // history got and is monotone, and the rows below it are drawn from
        // their own commits.
        if edge.folded || nodes.first().is_some_and(|node| edge.expects(&node.oid)) {
            let layout_start = Instant::now();
            let (rows, next) =
                assign_edge(Some(&edge), &nodes, limit as usize, MAX_LANES, follow_all);
            perf::mark("history.graph", graph_start.elapsed());
            perf::mark("history.layout", layout_start.elapsed());
            cache.advance(context, rev, first_parent, next);
            return Ok((nodes, rows, 0));
        }
    }
    let nodes = topology(
        directory,
        start.saturating_add(limit).saturating_add(1),
        rev,
        first_parent,
    )?;
    perf::mark("history.graph", graph_start.elapsed());
    let layout_start = Instant::now();
    let (rows, edge) = assign_edge(
        None,
        &nodes,
        start.saturating_add(limit) as usize,
        MAX_LANES,
        follow_all,
    );
    perf::mark("history.layout", layout_start.elapsed());
    cache.advance(context, rev, first_parent, edge);
    Ok((nodes, rows, start as usize))
}

/// One deterministic page of history. `--topo-order` keeps the sequence
/// stable for a fixed commit graph, and `--skip`/`-n` on the caller's
/// `start` cursor reproduces earlier pages byte for byte.
///
/// A page is drawn from the rows it contains plus the lanes the page above left
/// open, which is a complete description of the graph: in topological order a
/// parent is always below its child, so nothing in this window can be waiting
/// for a commit the window above did not already park. That is what a
/// [`GraphCache`] carries, and it is why one page is normally one Git process.
///
/// The page shows `limit` rows and lays out exactly those rows, which is what
/// makes the two routes meet: an edge handed on below them stops at the cursor
/// the next page asks with. The record read past `limit`, which answers only
/// "is there more", is cut out before anything is laid out — leave it in and
/// every boundary would sit one row below the request that wants it, so the
/// cache would never be used and nothing would say why.
///
/// When there is no boundary to continue — the first page, a moved history, a
/// page asked out of order — the whole prefix `[0, start + limit)` is read again
/// and laid out, which is slower and says the same thing. Either way every row
/// of the page gets the graph the whole history implies, so paging never breaks a
/// line, and the fold decision stays history-wide rather than per page.
pub fn page(
    directory: &Path,
    context: ReadContext,
    start: u64,
    target: Option<&str>,
    limit: u64,
    first_parent: bool,
    cache: &GraphCache,
) -> Result<HistoryPage, ProbeError> {
    let rev = pinned_rev(directory, target)?;
    let body_start = Instant::now();
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
    // The flag and the pinned commit travel with both routes below: the graph
    // is laid out over the same history the page lists, or the lanes would
    // describe commits that are not there.
    if first_parent {
        command.arg("--first-parent");
    }
    command.arg(&rev);
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
    // Four phases, four marks. The graph phase is the one that used to be a
    // second Git process ordering the whole repository again; the marks do not
    // change name, so a page that hits the remembered edge reports the phase
    // costing nothing rather than dropping it out of the log.
    perf::mark("history.body", body_start.elapsed());
    // The graph is laid out first so `parse` can hand every commit the row
    // for its own index, and compare the commit itself against the topology it
    // came from, refusing the page if the two disagree on either. One record
    // past the page is read, laid out and parsed for the same reason: see
    // `has_more` below.
    let body = output.stdout.as_slice();
    let (nodes, rows, offset) = window(
        directory,
        body,
        start,
        limit,
        &rev,
        first_parent,
        context,
        cache,
    )?;
    let parse_start = Instant::now();
    let mut commits = parse(body, &nodes, &rows, offset)?;
    perf::mark("history.parse", parse_start.elapsed());
    // The record the read asked for past the page is laid out and parsed with
    // the rest, because the question it answers — does the commit below this
    // page exist — is what decides whether the last row's line ends or runs on.
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

    /// The page these tests walk by: small enough that the merged fixture below
    /// crosses several seams rather than only the head and the root.
    const PAGE: u64 = 3;

    /// A limit deeper than any fixture these tests make, so that one read of it
    /// answers for the whole history.
    const DEEP: u64 = 40;

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

    /// A history that actually uses the lanes: two merges back into `main`, one of
    /// them a branch whose parent is shared with the other, and eleven commits —
    /// more than three pages at the limit these tests walk by. Page seams landing
    /// in the middle of a lane, rather than only at the head or the root, is the
    /// point: that is where an inherited edge has to be right.
    fn merged_repo() -> (tempfile::TempDir, PathBuf) {
        let (_root, repo) = fixture();
        commit(&repo, "base");
        git(&repo, &["branch", "side"]);
        git(&repo, &["branch", "other"]);
        commit(&repo, "main one");
        git(&repo, &["switch", "-q", "side"]);
        commit(&repo, "side one");
        commit(&repo, "side two");
        git(&repo, &["switch", "-q", "other"]);
        commit(&repo, "other one");
        git(&repo, &["switch", "-q", "main"]);
        commit(&repo, "main two");
        git(
            &repo,
            &["merge", "--no-ff", "-q", "-m", "took in side", "side"],
        );
        commit(&repo, "main three");
        git(
            &repo,
            &["merge", "--no-ff", "-q", "-m", "took in other", "other"],
        );
        commit(&repo, "main four");
        commit(&repo, "main five");
        (_root, repo)
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

    /// The topology those rows were assigned from: the same straight line, so a
    /// test hands `parse` a matching pair of reads rather than one at a time.
    fn plain_nodes(rows: usize) -> Vec<Node> {
        (0..rows)
            .map(|index| Node {
                oid: format!("{:040x}", index),
                parents: (index + 1 < rows)
                    .then(|| format!("{:040x}", index + 1))
                    .into_iter()
                    .collect(),
            })
            .collect()
    }

    /// One record in exactly the shape `LOG_FORMAT` emits: nine fields, the
    /// message closed by Git's own newline, the record closed by NUL.
    fn record(oid: &str, parents: &[&str]) -> String {
        format!(
            "{oid}\x1f{}\x1fguit test\x1fguit@example.invalid\x1f2026-01-01T00:00:00+00:00\
             \x1fguit test\x1fguit@example.invalid\x1f2026-01-01T00:00:00+00:00\x1fmessage\n\x00",
            parents.join(" "),
        )
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

    /// The context a live session's graph domain answers under. Every page a test
    /// reads asks with this one: which rows a page draws is what these tests are
    /// about, and a context that is not the live one is the session module's
    /// refusal to test.
    fn session() -> ReadContext {
        ReadContext {
            session_id: 1,
            generation: Some(0),
        }
    }

    /// One page read against the graph cache the pages above it were read with.
    /// Sharing a cache is the whole difference between the two routes through
    /// [`window`]: a second page asked of the first page's cache continues the
    /// edge that cache remembered, and one asked of a fresh cache re-reads the
    /// prefix. A test that reads one page and no more has no next page to
    /// continue, so the fresh cache below is the honest shape for it.
    fn read_page_with(
        cache: &GraphCache,
        repo: &Path,
        start: u64,
        target: Option<&str>,
        limit: u64,
        first_parent: bool,
    ) -> Result<HistoryPage, ProbeError> {
        page(repo, session(), start, target, limit, first_parent, cache)
    }

    fn read_page(
        repo: &Path,
        start: u64,
        target: Option<&str>,
        limit: u64,
        first_parent: bool,
    ) -> Result<HistoryPage, ProbeError> {
        read_page_with(
            &GraphCache::default(),
            repo,
            start,
            target,
            limit,
            first_parent,
        )
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
        let page = read_page(&repo, 0, None, 10, false).unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].message, body);
        assert_eq!(page.commits[0].subject, "subject line");
        assert_eq!(page.commits[0].author_name, "guit test");
        assert!(page.commits[0].author_date.contains('T'));
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
            let page = read_page(&repo, start, None, 3, false).unwrap();
            assert_eq!(page.start, start);
            collected.extend(page.commits.iter().map(|c| c.oid.clone()));
            if !page.has_more {
                break;
            }
            start += page.commits.len() as u64;
        }
        assert_eq!(collected, expected);
        // A second pass over the same cursor returns identical pages.
        let again = read_page(&repo, 3, None, 3, false).unwrap();
        assert_eq!(again.commits.len(), 3);
        assert_eq!(again.commits[0].oid, expected[3]);
    }

    /// The claim the whole of [`GraphCache`] rests on: a page drawn from its own
    /// records plus the lanes the page above left open is the same page the
    /// whole-prefix read draws. The walk checks the cheap route was really taken
    /// before it checks what it drew, because a page that quietly fell back
    /// would be right and prove nothing.
    #[test]
    fn the_edge_continues_where_the_prefix_read_agrees() {
        let (_root, repo) = merged_repo();
        let head = oid(&repo, "HEAD");
        // One read of the entire history: the list of commits every page below
        // is a cut from. It is not the comparison for the rows — a page says how
        // far its own window reached, and the row read past a page has a parent
        // in one window and not in the other — so only the identity of each row
        // is measured against it.
        let whole = read_page(&repo, 0, Some(&head), DEEP, false).unwrap();
        assert_eq!(whole.commits.len(), 11);
        assert!(!whole.has_more, "the fixture fits in one deep read here");

        let continued = GraphCache::default();
        let mut start = 0;
        let mut seams = 0;
        loop {
            if start > 0 {
                let edge = continued
                    .continue_from(session(), &head, false, start)
                    .unwrap_or_else(|| panic!("the page at {start} had no edge to continue"));
                // The witness the hit route asks for, asked before the read that
                // would take it: the row this page opens on is one the boundary
                // above left a lane open for. Drop it and the read below still
                // draws a correct page by re-reading the prefix.
                assert!(
                    edge.expects(&whole.commits[start as usize].oid),
                    "the page at {start} opens on a commit no lane above it holds"
                );
                seams += 1;
            }
            let page = read_page_with(&continued, &repo, start, Some(&head), PAGE, false).unwrap();
            // The same page asked of a cache that never saw the history above
            // it, which re-reads and re-lays-out the whole prefix instead.
            let alone = read_page(&repo, start, Some(&head), PAGE, false).unwrap();
            assert_eq!(
                page.commits, alone.commits,
                "the two routes drew different rows at {start}"
            );
            assert_eq!(page.has_more, alone.has_more);
            let shown = page.commits.len();
            assert!(shown > 0, "an empty page ended the walk at {start}");
            for (offset, commit) in page.commits.iter().enumerate() {
                assert_eq!(
                    commit.oid,
                    whole.commits[start as usize + offset].oid,
                    "row {offset} of the page at {start} is not the commit the history has there"
                );
            }
            start += shown as u64;
            if !page.has_more {
                break;
            }
        }
        assert!(seams >= 3, "the walk must cross page seams, not just one");
    }

    /// The extra record the page read asks for is what answers `has_more`, and it
    /// must not reach the boundary: an edge that stopped below it is an edge no
    /// request will ever match.
    #[test]
    fn an_edge_stops_at_the_cursor_the_next_page_asks_with() {
        let (_root, repo) = merged_repo();
        let head = oid(&repo, "HEAD");
        let cache = GraphCache::default();
        let page = read_page_with(&cache, &repo, 0, Some(&head), PAGE, false).unwrap();
        assert_eq!(page.commits.len(), usize::try_from(PAGE).unwrap());
        assert!(page.has_more, "the history is deeper than this page");
        assert!(
            cache
                .continue_from(session(), &head, false, page.commits.len() as u64)
                .is_some(),
            "the next page's cursor has an edge to continue"
        );
        assert!(
            cache
                .continue_from(session(), &head, false, PAGE + 1)
                .is_none(),
            "one row past the page is not where the edge stops"
        );
    }

    /// A page asked out of order is not a page this boundary was drawn from, and
    /// the fallback has to be both correct and temporary: it draws the page the
    /// prefix route draws, and it leaves the boundary the next page continues.
    #[test]
    fn a_page_asked_out_of_order_re_reads_the_prefix() {
        let (_root, repo) = merged_repo();
        let head = oid(&repo, "HEAD");
        let whole = read_page(&repo, 0, Some(&head), DEEP, false).unwrap();
        let cache = GraphCache::default();
        read_page_with(&cache, &repo, 0, Some(&head), PAGE, false).unwrap();
        // The user asked for the third page without the second.
        assert!(cache
            .continue_from(session(), &head, false, 2 * PAGE)
            .is_none());
        let jumped = read_page_with(&cache, &repo, 2 * PAGE, Some(&head), PAGE, false).unwrap();
        let expect: Vec<String> = whole.commits[6..9].iter().map(|c| c.oid.clone()).collect();
        assert_eq!(
            jumped
                .commits
                .iter()
                .map(|c| c.oid.clone())
                .collect::<Vec<String>>(),
            expect
        );
        assert!(jumped.has_more, "the history is deeper than this page");
        // The walk forward from here is served by the boundary this read left,
        // and served with the rows the whole-prefix route would have drawn.
        let resumed = read_page_with(&cache, &repo, 3 * PAGE, Some(&head), PAGE, false).unwrap();
        let alone = read_page(&repo, 3 * PAGE, Some(&head), PAGE, false).unwrap();
        assert_eq!(resumed.commits, alone.commits);
    }

    /// One boundary, and it answers only to the three things that say which
    /// history it was earned on: the session, the generation and the commit.
    #[test]
    fn a_boundary_is_keyed_on_the_read_that_earned_it() {
        let (_root, repo) = merged_repo();
        let head = oid(&repo, "HEAD");
        let cache = GraphCache::default();
        read_page_with(&cache, &repo, 0, Some(&head), PAGE, false).unwrap();
        assert!(cache.continue_from(session(), &head, false, PAGE).is_some());

        // A second session on the same repository shares the object store and
        // nothing else: its pages are its own.
        let second = ReadContext {
            session_id: 2,
            generation: Some(0),
        };
        assert!(cache.continue_from(second, &head, false, PAGE).is_none());
        page(&repo, second, PAGE, Some(&head), PAGE, false, &cache).unwrap();
        // The cache holds the read that wrote last, under that read's keys.
        assert!(cache
            .continue_from(session(), &head, false, 2 * PAGE)
            .is_none());
        assert!(cache
            .continue_from(second, &head, false, 2 * PAGE)
            .is_some());

        // A bumped graph generation is a different history claim, and so is a
        // different commit — a page of an older branch must not inherit the
        // lanes a page of the head left.
        let bumped = ReadContext {
            session_id: 2,
            generation: Some(1),
        };
        assert!(cache
            .continue_from(bumped, &head, false, 2 * PAGE)
            .is_none());
        let older = oid(&repo, "HEAD~1");
        assert!(cache
            .continue_from(second, &older, false, 2 * PAGE)
            .is_none());
        // Clearing is what closing a session does.
        cache.clear();
        assert!(cache
            .continue_from(second, &head, false, 2 * PAGE)
            .is_none());
    }

    /// The witness lives on the edge, so that is where it is pinned, on the
    /// shape a page window has: the rows it shows plus the one it reads to say
    /// whether there are more.
    #[test]
    fn an_edge_only_continues_a_page_whose_top_row_it_is_waiting_for() {
        let nodes = vec![node("a", &["b"]), node("b", &["c"]), node("c", &[])];
        let whole = assign_lanes_with(&nodes, MAX_LANES, true);
        // A page that shows one row out of a two-row window: `b` is read only to
        // say that the line below `a` does not end there.
        let (window, edge) = assign_edge(None, &nodes[..2], 1, MAX_LANES, true);
        assert_eq!(window[..1], whole[..1]);
        assert_eq!(
            edge.next_start, 1,
            "the edge stops at the row the page shows, not the row it read past it"
        );
        // The page below opens on `b` — the commit this window left a lane
        // holding — and on nothing else: `c` is `b`'s parent, and `b` is below
        // the boundary, so no lane above it has parked `c` yet.
        assert!(edge.expects(&oid_of("b")));
        assert!(!edge.expects(&oid_of("c")));
        assert!(!edge.expects(&oid_of("somewhere else")));
        // This is also where the two routes legitimately part, and why the claim
        // above is route against route rather than page against whole history:
        // this window never saw `c`, so it says `b`'s line dangles, and the page
        // below draws that row again with `c` in it.
        assert_ne!(window[1], whole[1]);
        // Continuing from the edge draws the rest of the history, and drawing it
        // over the whole window gives the same rows.
        let shown = nodes.len() - 1;
        let (rest, below) = assign_edge(Some(&edge), &nodes[1..], shown, MAX_LANES, true);
        assert_eq!(rest, whole[1..]);
        // The root closed every lane, so nothing below it is expected — and
        // there is nothing below it, which is what that says.
        assert_eq!(below.next_start, nodes.len() as u64);
        assert!(below.lanes.iter().all(Option::is_none));
    }

    /// What one window hands down is measured in lanes, never in commits, so
    /// neither a deep page nor a wide repository can grow the cache.
    #[test]
    fn past_the_lane_cap_keeps_the_inherited_state_small() {
        // A window exactly at the cap: drawn, and its lanes are the columns it
        // left open — never more than twice the cap, because a column below the
        // node is one of the node's own columns or fewer.
        let at_the_cap = fan_nodes(MAX_LANES as usize);
        let shown = at_the_cap.len() - 1;
        let (rows, edge) = assign_edge(None, &at_the_cap, shown, MAX_LANES, true);
        assert!(
            rows[..shown].iter().all(|row| !row.folded),
            "at the cap is drawn"
        );
        assert_eq!(edge.next_start, shown as u64);
        assert!(
            edge.lanes.len() <= 2 * usize::from(MAX_LANES),
            "an unfolded edge is bounded by the cap, not by the window: {} lanes",
            edge.lanes.len()
        );

        // Past it: the lanes are dropped rather than kept in case, and what
        // carries down is the fold alone — the shape that could otherwise grow
        // the state with the repository.
        let over = fan_nodes(300);
        let (rows, folded) = assign_edge(None, &over, over.len() - 1, MAX_LANES, true);
        assert!(rows.iter().all(|row| row.folded));
        assert!(
            folded.lanes.is_empty(),
            "a folded window hands down no lanes at all"
        );
        assert!(folded.folded && folded.peak > usize::from(MAX_LANES));
    }

    /// A folded history is still a history the user pages through, and the fold
    /// is the one thing a page cannot see for itself: how wide the graph got
    /// above it.
    #[test]
    fn a_folded_window_hands_the_fold_down_rather_than_re_deciding_it() {
        let nodes = fan_nodes(300);
        let whole = assign_lanes_with(&nodes, MAX_LANES, true);
        // A page of one row above the fan, read with the merge itself as the row
        // it only counts: the window sees 300 parents, so it folds on its own.
        let (window, edge) = assign_edge(None, &nodes[..2], 1, MAX_LANES, true);
        assert!(edge.folded, "the window above the fan already folded");
        assert_eq!(window[..1], whole[..1]);
        // Continued without lanes: every row below folds too, because the peak
        // only grows and the fold is a claim about the history, not the page.
        let (rest, below) = assign_edge(Some(&edge), &nodes[1..], nodes.len() - 1, MAX_LANES, true);
        assert_eq!(rest, whole[1..]);
        assert!(below.folded);
        assert_eq!(below.next_start, nodes.len() as u64);
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
        let page = read_page(&repo, 0, None, 10, false).unwrap();
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
        let error = parse(broken, &plain_nodes(4), &plain_graph(4), 0).unwrap_err();
        assert_eq!(error.code.as_str(), "history_protocol_error");
        // Empty input and trailing separators parse to zero commits.
        assert_eq!(
            parse(&[], &plain_nodes(4), &plain_graph(4), 0)
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            parse(b"\x00", &plain_nodes(4), &plain_graph(4), 0)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn a_row_without_a_graph_slot_is_refused_not_defaulted() {
        // A commit must never be drawn in a column nobody else agrees on: if
        // the graph ran out, the page is refused.
        let one = record(&"a".repeat(40), &[]);
        assert_eq!(
            parse(one.as_bytes(), &[], &[], 0)
                .unwrap_err()
                .code
                .as_str(),
            "history_graph_mismatch"
        );
    }

    /// A commit is not a slot. The two reads a page is made of are asked for one
    /// pinned commit, and `parse` checks that both answered about the same
    /// commit at every position — the first version of this only looked for a
    /// slot, so two histories of the same length drew one page out of both.
    #[test]
    fn two_reads_are_committed_to_the_same_commits_not_just_the_same_length() {
        let nodes = plain_nodes(2);
        let rows = plain_graph(2);
        // A slot exists at this position, and the commit listed there is not the
        // one the topology put there.
        let other_commit = record(&"f".repeat(40), &[]);
        assert_eq!(
            parse(other_commit.as_bytes(), &nodes, &rows, 0)
                .unwrap_err()
                .code
                .as_str(),
            "history_graph_mismatch"
        );
        // The id agrees and the parents do not. Lanes are assigned from the
        // parent list alone, so this row would draw a line into nothing.
        let first = format!("{:040x}", 0u32);
        let moved_parent = record(&first, &[&"e".repeat(40)]);
        assert_eq!(
            parse(moved_parent.as_bytes(), &nodes, &rows, 0)
                .unwrap_err()
                .code
                .as_str(),
            "history_graph_mismatch"
        );
        // The one pair the two reads do agree on parses, and keeps its parents.
        let agreed = record(&first, &[&format!("{:040x}", 1u32)]);
        let commits = parse(agreed.as_bytes(), &nodes, &rows, 0).unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].oid, first);
    }

    /// A page names one commit in both of its reads, so the history it returns
    /// cannot be a history that moved while the page was being read.
    #[test]
    fn a_pinned_commit_is_the_history_a_page_is_about() {
        let (_root, repo) = fixture();
        let first = commit(&repo, "first");
        commit(&repo, "second");
        let pinned = read_page(&repo, 0, Some(&first), 10, false).unwrap();
        // `first` is the head of that history even though HEAD has moved on:
        // the page is about the commit it was asked for, and nothing else.
        assert_eq!(pinned.commits.len(), 1);
        assert_eq!(pinned.commits[0].oid, first);
        assert!(!pinned.commits[0].parents.iter().any(|p| p == &first));
        // Asked with nothing pinned, the same repository answers for its HEAD.
        let head = read_page(&repo, 0, None, 10, false).unwrap();
        assert_eq!(head.commits[0].oid, oid(&repo, "HEAD"));
        assert_eq!(head.commits.len(), 2);
    }

    /// A repository may be written to while guit reads it, and Git guards those
    /// writes with `.git/index.lock`. A history read that needed that lock would
    /// fail every time an editor or a `git` command was mid-write, and the panel
    /// would report a repository whose history could not be read at all.
    /// Measured on Git 2.53 on this host; a Windows or macOS lock file is not a
    /// claim this test can make.
    #[test]
    fn a_page_read_needs_no_lock_someone_else_is_holding() {
        let (_root, repo) = fixture();
        commit(&repo, "one");
        let lock = repo.join(".git/index.lock");
        std::fs::write(&lock, b"").unwrap();
        let held =
            read_page(&repo, 0, None, 10, false).expect("a held lock is not a failed history");
        assert_eq!(held.commits.len(), 1);
        assert!(lock.exists(), "the read must not take over the lock either");
        std::fs::remove_file(&lock).unwrap();
        // Same repository, same read, lock gone: nothing about the held lock
        // changed what came back.
        let free = read_page(&repo, 0, None, 10, false).unwrap();
        assert_eq!(free.commits, held.commits);
    }

    #[test]
    fn unknown_target_and_empty_repository_are_structured_failures() {
        let (_root, repo) = fixture();
        let error = read_page(
            &repo,
            0,
            Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
            10,
            false,
        )
        .unwrap_err();
        assert_eq!(error.code.as_str(), "history_page_failed");
        assert!(!error.message.is_empty());
        // An unborn HEAD: the pin has nothing to name, and that is said as a
        // failed read rather than returned as a history with nothing in it. The
        // command layer gates this on the session's branch state first, so this
        // is the shape the module keeps for what does reach Git.
        let error = read_page(&repo, 0, None, 10, false).unwrap_err();
        assert_eq!(error.code.as_str(), "history_head_unresolved");
        assert!(!error.message.is_empty());
    }

    /// A bare repository reports no branch in its snapshot, so nothing can be
    /// pinned from the session and the page resolves the commit itself. Turning
    /// an ordinary repository bare after committing is the same object store the
    /// session read would be handed, with no work tree in front of it.
    #[test]
    fn a_bare_repository_resolves_its_own_head_for_every_page() {
        let (_root, repo) = fixture();
        let only = commit(&repo, "only");
        git(&repo, &["config", "core.bare", "true"]);
        let first = read_page(&repo, 0, None, 10, false).unwrap();
        assert_eq!(first.commits.len(), 1);
        assert_eq!(first.commits[0].oid, only);
        assert_eq!(first.commits[0].subject, "only");
        // The same repository a second time answers the same way: the pin is
        // re-resolved per page, not remembered from the page before.
        assert_eq!(
            read_page(&repo, 0, None, 10, false).unwrap().commits,
            first.commits
        );
        // A bare repository with nothing committed is a refusal, not a void.
        let root = tempfile::tempdir().unwrap();
        let empty = root.path().join("empty.git");
        std::fs::create_dir(&empty).unwrap();
        git(
            &empty,
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        assert_eq!(
            read_page(&empty, 0, None, 10, false)
                .unwrap_err()
                .code
                .as_str(),
            "history_head_unresolved"
        );
    }

    #[test]
    fn a_target_that_is_not_a_full_commit_id_never_reaches_git() {
        let (_root, repo) = fixture();
        commit(&repo, "one");
        // A revspec, an option and a path are all things a `git log` argument
        // could be made to mean. The page module owns its own argv, so this is
        // refused there and never spoken to the process.
        for candidate in ["HEAD", "--all", "refs/heads/main", "one", ""] {
            let error = read_page(&repo, 0, Some(candidate), 10, false).unwrap_err();
            assert_eq!(error.code.as_str(), "history_target_invalid", "{candidate}");
        }
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

    /// A page carries commits and their places in the graph, and nothing about
    /// what anything is called. Naming used to be this read's own field: a tag
    /// added afterwards could not reach a page already read, while the refresh
    /// that noticed it moved the very names the panel shows beside that page —
    /// so a row's label and its own lane came from two instants of one refresh.
    /// The names are a separate read now, invalidated with the names, and this
    /// read is provably indifferent to what the repository is called.
    #[test]
    fn a_page_is_the_same_history_whatever_the_repository_is_called() {
        let (_root, repo) = fixture();
        let oid = commit(&repo, "tagged");
        let before = read_page(&repo, 0, Some(&oid), 10, false).unwrap();
        git(&repo, &["tag", "v1"]);
        git(&repo, &["branch", "keep"]);
        git(&repo, &["update-ref", "refs/remotes/origin/main", &oid]);
        let after = read_page(&repo, 0, Some(&oid), 10, false).unwrap();
        assert_eq!(before.commits, after.commits, "no field of a row is a name");
        assert!(!after.commits.is_empty(), "the history was read at all");
    }

    #[test]
    fn first_parent_keeps_only_the_mainline_and_its_graph_agrees() {
        // The flag has to reach *both* reads, or the graph would be laid out
        // over a history the page is not showing.
        let (_root, repo) = fixture();
        let base = commit(&repo, "base");
        git(&repo, &["branch", "side"]);
        commit(&repo, "on main");
        git(&repo, &["switch", "-q", "side"]);
        commit(&repo, "on side");
        git(&repo, &["switch", "-q", "main"]);
        git(
            &repo,
            &["merge", "--no-ff", "-q", "-m", "the merge", "side"],
        );

        let all = read_page(&repo, 0, None, 20, false).unwrap();
        assert!(
            all.commits.iter().any(|c| c.subject == "on side"),
            "the default keeps every reachable commit"
        );
        let first = read_page(&repo, 0, None, 20, true).unwrap();
        assert!(
            !first.commits.iter().any(|c| c.subject == "on side"),
            "first-parent leaves the side branch out"
        );
        assert!(first.commits.iter().any(|c| c.subject == "the merge"));
        assert!(first.commits.iter().any(|c| c.oid == base));
        // A first-parent history is a straight line: the merge is still marked
        // as a merge (it factually is one) but nothing branches off it, and no
        // lane is left running.
        for commit in &first.commits {
            assert!(commit.graph.lanes.is_empty(), "{}", commit.subject);
            assert!(commit.graph.branches.is_empty(), "{}", commit.subject);
            assert!(commit.graph.incoming.is_empty(), "{}", commit.subject);
        }
        let merge = first
            .commits
            .iter()
            .find(|c| c.subject == "the merge")
            .unwrap();
        assert!(merge.graph.merge, "it is still a merge commit by fact");
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
        assert_eq!(error.code.as_str(), "commit_files_failed");
        assert!(!error.message.is_empty());
    }

    #[test]
    fn parse_files_rejects_malformed_streams_instead_of_guessing() {
        assert!(parse_files(&[]).unwrap().is_empty());
        // A bare NUL is not a stream diff-tree can produce: records always
        // pair a status with at least one path.
        assert_eq!(
            parse_files(b"\x00").unwrap_err().code.as_str(),
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
            assert_eq!(
                error.code.as_str(),
                "history_protocol_error",
                "input: {broken:?}"
            );
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

    /// The whole-history route, asked the way a test needs it: every row of the
    /// window is drawn, so there is nothing left to hand down. Production draws
    /// every window through [`assign_edge`], which is the same computation with
    /// a boundary above it.
    fn assign_lanes_with(nodes: &[Node], max_lanes: Lane, follow_all: bool) -> Vec<GraphRow> {
        assign_edge(None, nodes, nodes.len(), max_lanes, follow_all).0
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
        let rows = assign_lanes_with(nodes, max_lanes, true);
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
        let rows = assign_lanes_with(&nodes, MAX_LANES, true);
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
        let rows = assign_lanes_with(&nodes, MAX_LANES, true);
        let merge = &rows[2];
        assert!(merge.merge);
        assert_eq!(merge.node, 0, "the merge sits on the mainline column");
        assert!(merge.exit, "its first parent continues downward");
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
        let rows = assign_lanes_with(&nodes, MAX_LANES, true);
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
        let rows = assign_lanes_with(&nodes, MAX_LANES, true);
        assert!(!rows[0].dangling, "a's parent is the next row down");
        assert!(rows[1].dangling, "b's parent is not in the window");
        // Add the missing parent: it is now inside the window, so no line
        // leaves the loaded range.
        let mut full = nodes.clone();
        full.push(node("c", &[]));
        let rows = assign_lanes_with(&full, MAX_LANES, true);
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
        let whole = assign_lanes_with(&nodes, MAX_LANES, true);
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
        let rows = assign_lanes_with(&nodes, MAX_LANES, true);
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
        let rows = assign_lanes_with(&nodes, MAX_LANES, true);
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
        let rows = assign_lanes_with(&nodes, MAX_LANES, true);
        assert!(
            rows.iter().all(|row| row.folded),
            "an over-wide graph folds"
        );
        // Folded, the mainline is still continuous and nothing collides.
        assert!(rows.iter().all(|row| row.node == 0));
        assert!(rows.iter().all(|row| row.lanes.is_empty()));
    }

    /// The same history as the topology a window is laid out over rather than as
    /// the rows it draws: an edge is handed down from nodes, not from rows.
    fn fan_nodes(branches: usize) -> Vec<Node> {
        let mut nodes = vec![node("top", &["fork"])];
        let names: Vec<String> = (0..branches).map(|index| format!("b{index}")).collect();
        let parents: Vec<&str> = names.iter().map(String::as_str).collect();
        nodes.push(node("fork", &parents));
        for name in &names {
            nodes.push(node(name, &["base"]));
        }
        nodes.push(node("base", &[]));
        nodes
    }

    /// A history with `branches` extra parents open at once: one commit whose
    /// first parent continues the mainline and whose other parents each run
    /// down to a shared base. The live lane count of such a window is
    /// `branches`, so it is the shape to ask about the gutter's width.
    fn fan(branches: usize) -> Vec<GraphRow> {
        assign_lanes_with(&fan_nodes(branches), MAX_LANES, true)
    }

    #[test]
    fn a_fan_wider_than_the_lane_type_is_folded_never_renumbered() {
        // 300 branches open at once: past the largest number a column is
        // carried in. The layout counts in a wider type and the fold discards
        // its rows, so a wrapped column cannot reach a page — what the page
        // says instead is that the branches are not drawn.
        let rows = fan(300);
        assert!(rows.iter().all(|row| row.folded));
        assert!(rows.iter().all(|row| row.node == 0));
        // Folded is not empty: the mainline stays continuous, and the merge
        // that opened 300 branches is still drawn as a merge.
        assert!(rows[0].exit, "a line still leaves the first row");
        assert!(
            rows[1].merge && rows[1].entry,
            "the fan's commit is still a merge with a line arriving"
        );
    }

    #[test]
    fn a_window_at_the_lane_cap_is_drawn_and_one_more_folds() {
        // The cap is the boundary the announcement quotes, so pin it: a window
        // with exactly `MAX_LANES` live columns is drawn and its rightmost
        // column is the gutter's last, one more column folds.
        let at_the_cap = fan(usize::from(MAX_LANES));
        assert!(
            at_the_cap.iter().all(|row| !row.folded),
            "a graph the gutter has room for is drawn"
        );
        let widest = at_the_cap
            .iter()
            .flat_map(|row| {
                std::iter::once(row.node)
                    .chain(row.lanes.iter().copied())
                    .chain(row.branches.iter().copied())
                    .chain(row.incoming.iter().copied())
            })
            .max()
            .expect("a drawn window carries columns");
        assert_eq!(
            widest,
            MAX_LANES - 1,
            "the rightmost column drawn is the gutter's last"
        );
        assert!(
            fan(usize::from(MAX_LANES) + 1).iter().all(|row| row.folded),
            "one column past the gutter folds the window"
        );
    }

    #[test]
    fn assignment_is_deterministic_so_a_lane_keeps_its_column() {
        let nodes = branched_history();
        let first = assign_lanes_with(&nodes, MAX_LANES, true);
        let second = assign_lanes_with(&nodes, MAX_LANES, true);
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
                parse_topology(broken.as_bytes()).unwrap_err().code.as_str(),
                "history_protocol_error",
                "input: {broken:?}"
            );
        }
    }
}
