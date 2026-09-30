//! The search scan: one query, one window of history read from Git, matched in
//! Rust, with every hit addressed back into the text it was found in.
//!
//! This is the half of search that has to be Rust's: the panel has fifty
//! commits on screen, the answer may be commit nine hundred, and finding it
//! means reading the repository rather than the page. What comes back is typed
//! results and offsets, never a rendered row — [`crate::fuzzy`] holds the one
//! folding and ranking policy, this module decides what it is pointed at.
//!
//! Three measurements decide the shape:
//!
//! * **A window is one process.** Resuming with a larger `--skip` pays the
//!   history walk again (8.9 ms at skip 0 against 34.2 ms at skip 6000 in a
//!   6,524-commit repository, p50 of nine warm runs), so many narrow windows
//!   would scan in quadratic time. A window is wide ([`WINDOW_RECORDS`]) and a
//!   cursor moves by whole windows.
//! * **Recency, not topology.** `--topo-order` costs a repository-wide sort
//!   whether the read asked for 50 commits or all of them (34.6 ms against
//!   5.9 ms for the same 50 records), and a result list has no gutter to keep
//!   aligned. Hits come back newest first; the drawn graph is a separate read
//!   whose order nothing here touches.
//! * **Nothing the query says reaches argv.** An object id is compared inside
//!   Rust, so searching for `HEAD~5` or `refs/heads/main^` matches nothing
//!   rather than asking Git about it. Only the session's pinned full commit id
//!   names a revision, validated by [`crate::history::valid_oid`], and every
//!   command still ends with its `--` separator.
//!
//! A read that came back short is an error, never a smaller answer: a truncated
//! capture, a failed exit, a record that does not split into the four fields the
//! format asked for, or an id that is not an id all refuse the whole window.

// The scan is reached only by its tests so far: the command that carries it
// belongs to the search context, and the attribute goes with that registration.
#![allow(dead_code)]

use crate::fuzzy::{self, Field, Query};
use crate::history::valid_oid;
use crate::perf;
use crate::probe::{redact, ProbeError};
use crate::session;
use crate::{refs, repo, runner};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Field separator inside one log record and record separator emitted by
/// `git log -z` — the same protocol as `history.rs`, for the same reason: Git
/// refuses to create a commit whose message holds a NUL, while 0x1f can appear
/// inside a message, so the free text is the last field and the split is capped
/// at the field count rather than left open-ended.
const FIELD_SEP: u8 = 0x1f;
const RECORD_SEP: u8 = 0x00;
const FIELD_COUNT: usize = 4;
/// Object id, committer date, author, then the whole message. The message is
/// searched as one text so a hit has exactly one coordinate system per row;
/// where the subject line ends is a number rather than a second string.
const SEARCH_FORMAT: &str = "%H%x1f%cI%x1f%an%x1f%B";
/// A window is read with one spare record, the way a history page is: the
/// record that does not belong to the window is what proves more history
/// follows, and it is dropped rather than returned — so `complete` rests on
/// Git's own answer instead of a count this module guessed.
const SPARE_RECORDS: u64 = 1;
/// Records read per window, from measurement rather than from the display: a
/// window of 1,000 commits cost 16 ms of Git time in the 6,524-commit
/// repository above and 11–13 ms in two smaller ones, against a 5.4 ms spawn
/// floor paid per read whatever its size. Seven windows then cover that
/// repository, where 131 windows of 50 would have paid walk and spawn each.
pub const WINDOW_RECORDS: u64 = 1_000;
/// How far one search will walk from the pinned head, in records, whatever it
/// finds on the way: the time-and-memory ceiling for a whole scan, separate
/// from a window's size and from the result caps below. Reaching it stops the
/// scan with [`STOP_SCAN_CAP`] named and never implies the history was covered.
pub const MAX_SCANNED_RECORDS: u64 = 100_000;
/// Commits returned per window. Independent of [`WINDOW_RECORDS`] (a window can
/// match far more than it may report) and of what the overlay draws at once,
/// which is the view's number. When more match than fit the weakest are dropped
/// and `hits_truncated` says so; the scan itself is not cut short here.
pub const MAX_WINDOW_COMMITS: usize = 100;
/// References returned per search, again its own number: a query like `a`
/// matches most names in a repository with hundreds of them, and a list that
/// long is noise rather than an answer.
pub const MAX_WINDOW_REFS: usize = 50;
/// Long messages are why a search read needs a bound of its own: 1,000 commits
/// measured 130–280 KB, and a repository with a 6 MB message would pass the
/// default capture bound's silent cut. Same size as the history read's bound,
/// and tripping it is an error rather than a shorter window.
const SEARCH_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
/// Shortest query still read as an object-id prefix. Shorter than this a run of
/// hex is far more likely to be a word (`dead`, `cafe`, `abc`) than an
/// abbreviation, and an id hit outranks every prose hit — guessing would
/// reorder the list to serve the rarer reading.
const MIN_OID_QUERY_CHARS: usize = 7;
/// Longest query accepted, in characters. Folding the query is once per search,
/// but matching carries it through every record's text, so an absurd paste costs
/// per record. A bound, not a widget limit.
const MAX_QUERY_CHARS: usize = 256;
/// Reachability probes per search, in Git spawns, each paying the 5 ms floor.
/// Names past the budget are reported as unanswered rather than answered by a
/// scan that had not reached them.
const MAX_REACHABILITY_PROBES: usize = 8;

/// Why a scan stopped before the history ended. Its absence together with
/// `complete: false` means only that another cursor exists — never that nothing
/// matched.
pub const STOP_SCAN_CAP: &str = "search_scan_capped";

/// Which field a commit hit was found in, ranked best first. The ladder *within*
/// a field is the matcher's; across fields an id beats a subject, a subject
/// beats a body, a body beats an author — the caller's half of the ranking key,
/// fixed here so two views cannot order one answer differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HitField {
    Oid,
    Subject,
    Body,
    Author,
}

/// One match and where it sits. Offsets index exactly one string, chosen by
/// `field`: `message` for Subject and Body, `author_name` for Author, `oid` for
/// Oid. Both addressings, and the snapping of every fragment to whole grapheme
/// clusters, are [`crate::fuzzy`]'s.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub field: HitField,
    /// How good a match was, in the matcher's own words: the ladder serializes
    /// to `exact`, `prefix`, `contiguous` or `subsequence`, so a view can say
    /// that without re-deriving it, and a value that is not one of the four
    /// cannot be built.
    pub tier: fuzzy::Tier,
    /// Ascending, never overlapping, never adjacent.
    pub fragments: Vec<fuzzy::Fragment>,
}

/// A commit that matched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitHit {
    pub oid: String,
    /// The whole message, trailing newline removed — the one text every subject
    /// and body fragment indexes. The first line is the subject line, addressed
    /// by the two numbers below rather than shipped again: an escaped display
    /// name would be a string the offsets no longer described.
    pub message: String,
    /// Where the subject line ends, in bytes of `message` and in UTF-16 units of
    /// the same text, so a row that titles itself with the first line and a
    /// renderer that highlights the message agree without computing anything.
    pub subject_end_bytes: usize,
    pub subject_end_units: usize,
    pub author_name: String,
    pub commit_date: String,
    /// Position in the history from the pinned head, newest at 0 — the same
    /// number a cursor moves by, so a view holding this page can see that a hit
    /// was already on screen.
    pub offset: u64,
    /// Every field that matched, best first. A query hitting both the subject
    /// and the body of one commit reports both, so a highlight below the
    /// visible line is explained rather than mysterious.
    pub hits: Vec<Hit>,
}

/// Which sort of name matched. `Remote` is a remote-tracking ref: local
/// metadata about a remote, never current remote state, and a separate value is
/// what lets a view say that rather than imply it by showing a branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Branch,
    Tag,
    Remote,
}

/// A name that matched: branch, tag or remote-tracking ref. Its fragments index
/// `name`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefHit {
    pub kind: RefKind,
    pub name: String,
    /// The commit this name joins a history on, when it names one: a tag on a
    /// tree or a blob has no row to sit on, which is a fact about the tag rather
    /// than a read that failed.
    pub commit_oid: Option<String>,
    pub head: bool,
    /// Whether that commit lies in the history of the pinned head. Only
    /// `Some(false)` may be worded as being outside the current branch's
    /// history, and it comes from a probe that ran — never from a scan that
    /// stopped early. `None` means no probe reached this name.
    pub reached_from_head: Option<bool>,
    pub tier: fuzzy::Tier,
    pub fragments: Vec<fuzzy::Fragment>,
}

/// One window of one search. The cursor is what turns a repeated read into a
/// scan: a caller asks again with `next_cursor` until `complete`, and only a
/// completed scan that found nothing is an answer of "nothing matched".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWindow {
    /// Records skipped before this window — what the caller asked with.
    pub cursor: u64,
    pub scanned: u64,
    pub complete: bool,
    pub stopped_by: Option<String>,
    pub next_cursor: Option<u64>,
    /// More commits matched than this window returned.
    pub hits_truncated: bool,
    pub commits: Vec<CommitHit>,
    /// Names, matched on the first window only: the listing does not move while
    /// the history is walked, and repeating it would sort the same names into
    /// every page.
    pub refs: Vec<RefHit>,
}

/// One `-z` record, owned and checked.
struct Record {
    oid: String,
    commit_date: String,
    author_name: String,
    message: String,
}

/// A match with the matcher's own key kept next to it, so ordering never has to
/// guess a rank back out of the fragments it was built from.
struct Match {
    field: HitField,
    tier: fuzzy::Tier,
    rank: (u8, usize, usize),
    fragments: Vec<fuzzy::Fragment>,
}

/// A matched commit: its best key for the ordering, its place in the history,
/// and the text a row is built from.
struct Matched {
    key: (HitField, (u8, usize, usize)),
    offset: u64,
    record: Record,
    hits: Vec<Match>,
}

/// The query read as an object-id prefix, when it is one: at least
/// [`MIN_OID_QUERY_CHARS`] hex characters. Uppercase is accepted because people
/// copy ids out of tools that show them uppercase; the ids themselves are not.
fn oid_prefix_of(query: &str) -> Option<String> {
    if query.len() < MIN_OID_QUERY_CHARS || !query.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(query.to_ascii_lowercase())
}

/// Where the first line of `message` ends, in bytes and in UTF-16 units.
fn subject_bounds(message: &str) -> (usize, usize) {
    let bytes = message.find('\n').unwrap_or(message.len());
    (bytes, message[..bytes].encode_utf16().count())
}

fn split_record(record: &[u8]) -> Option<Record> {
    let fields: Vec<&[u8]> = record
        .splitn(FIELD_COUNT, |byte| *byte == FIELD_SEP)
        .collect();
    let (oid, commit_date, author_name, message) = match fields.as_slice() {
        [oid, commit_date, author_name, message] => (*oid, *commit_date, *author_name, *message),
        _ => return None,
    };
    // One trailing newline is `%B`'s own terminator, not part of the message;
    // leaving it in would put a blank line between subject and body and shift
    // every body offset.
    let message = match message.split_last() {
        Some((b'\n', rest)) => rest,
        _ => message,
    };
    // An id that is not an id means this stream is not the one the format
    // described, and every offset below would be measured against a guess.
    let oid = String::from_utf8(oid.to_vec()).ok()?;
    if !valid_oid(&oid) {
        return None;
    }
    Some(Record {
        oid,
        commit_date: String::from_utf8_lossy(commit_date).into_owned(),
        author_name: String::from_utf8_lossy(author_name).into_owned(),
        message: String::from_utf8_lossy(message).into_owned(),
    })
}

/// Matches one record: its id by prefix, its message and its author through the
/// matcher, best field first.
fn matches_of(record: &Record, query: &Query, oid_prefix: Option<&str>) -> Vec<Match> {
    let mut found: Vec<Match> = Vec::new();

    // An object id is resolved, not scored: the prefix is either there or it is
    // not, and prose never fuzzy-matches its way onto an id.
    if let Some(prefix) = oid_prefix {
        if record.oid.starts_with(prefix) {
            let tier = if prefix.len() == record.oid.len() {
                fuzzy::Tier::Exact
            } else {
                fuzzy::Tier::Prefix
            };
            found.push(Match {
                field: HitField::Oid,
                tier,
                // The same three-part key the matcher builds for a scored hit,
                // so an id and a message compete on one ladder: an id match
                // spans exactly what it matched, so both counts are the length
                // of the prefix.
                rank: (tier as u8, prefix.chars().count(), prefix.chars().count()),
                fragments: vec![fuzzy::Fragment {
                    byte_start: 0,
                    byte_end: prefix.len(),
                    unit_start: 0,
                    unit_end: prefix.len(),
                }],
            });
        }
    }

    if let Some(hit) = Field::new(&record.message).find(query) {
        // One text, two labels: a match that stays inside the first line is a
        // subject match and anything crossing the line break is a body match.
        let (subject_end, _) = subject_bounds(&record.message);
        let in_subject = hit
            .fragments
            .last()
            .is_some_and(|fragment| fragment.byte_end <= subject_end);
        found.push(Match {
            field: if in_subject {
                HitField::Subject
            } else {
                HitField::Body
            },
            tier: hit.tier,
            rank: hit.rank(),
            fragments: hit.fragments,
        });
    }

    if let Some(hit) = Field::new(&record.author_name).find(query) {
        found.push(Match {
            field: HitField::Author,
            tier: hit.tier,
            rank: hit.rank(),
            fragments: hit.fragments,
        });
    }

    found.sort_by_key(|matched| (matched.field, matched.rank));
    found
}

/// Reads `[cursor, cursor + records)` of the history from `rev` in one process.
///
/// Split from [`scan`] so a test can overset the capture bound: the output limit
/// is the one argument a repository cannot exceed on purpose.
fn read_window(
    directory: &Path,
    rev: &str,
    cursor: u64,
    records: u64,
    output_limit: usize,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args([
        "log",
        "--no-color",
        "-z",
        &format!("--format={SEARCH_FORMAT}"),
        "-n",
        &records.to_string(),
        "--skip",
        &cursor.to_string(),
        rev,
        // Last, as in every other read: nothing in a record can be re-read as an
        // option, and an empty pathspec limits nothing.
        "--",
    ]);
    let output = runner::run_with_limit(
        command,
        cancelled,
        Duration::ZERO,
        Duration::from_secs(30),
        output_limit,
        |_, _| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "search_truncated",
            "The search window exceeded the capture bound; nothing was parsed.",
        ));
    }
    if !output.status.success() {
        let detail = redact(&String::from_utf8_lossy(&output.stderr));
        let first_line = detail.lines().next().unwrap_or("").to_owned();
        return Err(ProbeError::new("search_window_failed", first_line));
    }
    Ok(output.stdout)
}

/// Whether `oid`'s commit lies in the history of `rev`, asked of Git instead of
/// inferred: exit 0 is inside, exit 1 is outside, anything else is a failed read.
fn probe_reachable(
    directory: &Path,
    oid: &str,
    rev: &str,
    cancelled: &AtomicBool,
) -> Result<bool, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args(["merge-base", "--is-ancestor", oid, rev]);
    let output = runner::run_with_limit(
        command,
        cancelled,
        Duration::ZERO,
        Duration::from_secs(30),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "search_truncated",
            "The reachability answer exceeded its bound; nothing was concluded.",
        ));
    }
    if output.status.success() {
        return Ok(true);
    }
    // Git's "no" is a plain exit 1 with nothing on stderr; a code beyond it is a
    // ref naming no commit, which is a failed read rather than an answer.
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    let detail = redact(&String::from_utf8_lossy(&output.stderr));
    let first_line = detail.lines().next().unwrap_or("").to_owned();
    Err(ProbeError::new("search_reach_failed", first_line))
}

/// Matches the repository's own names. Reached for the first window only.
fn ref_hits(
    directory: &Path,
    query: &Query,
    rev: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<RefHit>, ProbeError> {
    let listing = refs::list(directory)?;
    // The matcher's key is carried beside each hit rather than reconstructed
    // from its fragments afterwards: a name list ordered by a guess about the
    // window width would disagree with the commit list ordered by the real one.
    let mut found: Vec<((u8, usize, usize), RefHit)> = Vec::new();
    let mut push =
        |kind: RefKind, name: String, commit_oid: Option<String>, head: bool, hit: fuzzy::Hit| {
            let rank = hit.rank();
            found.push((
                rank,
                RefHit {
                    kind,
                    name,
                    commit_oid,
                    head,
                    reached_from_head: None,
                    tier: hit.tier,
                    fragments: hit.fragments,
                },
            ));
        };
    for branch in listing.branches {
        if let Some(hit) = Field::new(&branch.name).find(query) {
            push(
                RefKind::Branch,
                branch.name,
                Some(branch.oid),
                branch.head,
                hit,
            );
        }
    }
    for tag in listing.tags {
        if let Some(hit) = Field::new(&tag.name).find(query) {
            push(RefKind::Tag, tag.name, tag.commit_oid, false, hit);
        }
    }
    for remote in listing.remotes {
        if let Some(hit) = Field::new(&remote.name).find(query) {
            push(RefKind::Remote, remote.name, Some(remote.oid), false, hit);
        }
    }
    // Names have no field to break a tie, so the matcher's key alone orders
    // them, and equal keys keep the listing's order.
    found.sort_by_key(|entry| entry.0);
    found.truncate(MAX_WINDOW_REFS);
    let mut found: Vec<RefHit> = found.into_iter().map(|entry| entry.1).collect();
    // Annotating every name would cost one process each. The pinned commit needs
    // no process at all, and the rest are answered in list order until the
    // budget is spent; an unanswered name says `None` rather than borrowing a
    // conclusion the history scan had not reached.
    let mut probes = 0usize;
    for hit in &mut found {
        let Some(oid) = hit.commit_oid.clone() else {
            continue;
        };
        if oid == rev {
            hit.reached_from_head = Some(true);
            continue;
        }
        if probes >= MAX_REACHABILITY_PROBES {
            break;
        }
        hit.reached_from_head = Some(probe_reachable(directory, &oid, rev, cancelled)?);
        probes += 1;
    }
    Ok(found)
}

/// Reads and matches one window of the history from `rev`.
///
/// `rev` is the commit the session was published with, checked here as well as
/// at the command layer because it is about to become an argument to Git.
pub fn scan(
    directory: &Path,
    rev: &str,
    query: &str,
    cursor: u64,
    cancelled: &AtomicBool,
) -> Result<SearchWindow, ProbeError> {
    let trimmed = query.trim();
    if trimmed.chars().count() > MAX_QUERY_CHARS {
        return Err(ProbeError::new(
            "search_query_too_long",
            "The query is longer than a search over every message will carry.",
        ));
    }
    if !valid_oid(rev) {
        return Err(ProbeError::new(
            "search_target_invalid",
            "A search reads one commit's history, named by its full id.",
        ));
    }
    if cursor > MAX_SCANNED_RECORDS {
        return Err(ProbeError::new(
            STOP_SCAN_CAP,
            "This search already walked as far as it goes; the history was not fully searched.",
        ));
    }

    let folded = Query::new(trimmed);
    if folded.is_empty() {
        // Not "nothing matched": a query that is empty, or that folds away to
        // nothing, has no answer — and a view rendering one would show an empty
        // list for a search that was never made.
        return Err(ProbeError::new(
            "search_query_empty",
            "No text was given to search for.",
        ));
    }
    let oid_prefix = oid_prefix_of(trimmed);

    let read_start = Instant::now();
    let bytes = read_window(
        directory,
        rev,
        cursor,
        WINDOW_RECORDS + SPARE_RECORDS,
        SEARCH_OUTPUT_LIMIT,
        cancelled,
    )?;
    perf::mark("search.window", read_start.elapsed());

    let match_start = Instant::now();
    let mut parsed = 0u64;
    let mut matched: Vec<Matched> = Vec::new();
    for record in bytes.split(|byte| *byte == RECORD_SEP) {
        if record.is_empty() {
            continue;
        }
        let Some(record) = split_record(record) else {
            return Err(ProbeError::new(
                "search_protocol_error",
                "Git returned a commit in an unexpected shape; the window was refused.",
            ));
        };
        let offset = cursor + parsed;
        parsed += 1;
        let hits = matches_of(&record, &folded, oid_prefix.as_deref());
        if hits.is_empty() {
            continue;
        }
        let key = (hits[0].field, hits[0].rank);
        matched.push(Matched {
            key,
            offset,
            record,
            hits,
        });
    }
    // A stable sort keeps equal keys in the order the scan read them, which is
    // newest first: the recency rule is the record order, not a comparison.
    matched.sort_by_key(|entry| entry.key);
    let hits_truncated = matched.len() > MAX_WINDOW_COMMITS;
    matched.truncate(MAX_WINDOW_COMMITS);
    let commits: Vec<CommitHit> = matched
        .into_iter()
        .map(|entry| {
            let (subject_end_bytes, subject_end_units) = subject_bounds(&entry.record.message);
            CommitHit {
                oid: entry.record.oid,
                message: entry.record.message,
                subject_end_bytes,
                subject_end_units,
                author_name: entry.record.author_name,
                commit_date: entry.record.commit_date,
                offset: entry.offset,
                hits: entry
                    .hits
                    .into_iter()
                    .map(|hit| Hit {
                        field: hit.field,
                        tier: hit.tier,
                        fragments: hit.fragments,
                    })
                    .collect(),
            }
        })
        .collect();
    perf::mark("search.match", match_start.elapsed());

    // The spare record is what says the history continues; it is dropped rather
    // than matched, so a window never reports a commit it did not grant.
    let scanned = parsed.min(WINDOW_RECORDS);
    let complete = parsed <= WINDOW_RECORDS;

    let refs = if cursor == 0 {
        let ref_start = Instant::now();
        let names = ref_hits(directory, &folded, rev, cancelled)?;
        perf::mark("search.refs", ref_start.elapsed());
        names
    } else {
        Vec::new()
    };

    // The cap bounds the walk, not the caller's understanding of it: a scan
    // that reached it leaves no cursor behind and names why it stopped, so the
    // view can say "searched as far as" instead of "no more results".
    let capped = !complete && cursor + scanned >= MAX_SCANNED_RECORDS;
    Ok(SearchWindow {
        cursor,
        scanned,
        complete,
        stopped_by: capped.then(|| STOP_SCAN_CAP.to_owned()),
        next_cursor: (!complete && !capped).then_some(cursor + scanned),
        hits_truncated,
        commits,
        refs,
    })
}

/// Which search a window belongs to, and what the scan was standing on while it
/// ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    /// Echoed back, not read out of the query: a view that has moved on decides
    /// whether this answer is about the question it still asks, and it can only
    /// do that if the answer names the question it is an answer to.
    pub query_id: u64,
    /// The commit every `offset` in `window` counts back from, named rather than
    /// implied. An offset locates a row in one history only: jumping to a hit is
    /// a second read of that commit, and this is the number that says whether the
    /// offset beside it still describes the graph on screen.
    pub head: String,
    /// The refs generation the name listing was taken under. Names are listed
    /// during the scan, so they cannot be older than the scan — they can be
    /// newer than the names on screen, and this is read before the listing
    /// rather than after, so a refresh that moved the names mid-scan makes the
    /// answer look older than it is. A view comparing it to its own screen then
    /// drops the names it cannot confirm instead of merging in a branch that has
    /// since been renamed.
    pub refs_generation: u64,
    pub window: SearchWindow,
}

/// The claim one search holds: which session asked, which query it was, and the
/// flag its reads poll.
struct Claim {
    session_id: u64,
    query_id: u64,
    cancelled: Arc<AtomicBool>,
}

/// One search at a time, per application.
///
/// A scan of a large history is not instant, and a reader who keeps typing does
/// not want the answer to what they typed a second ago. One slot holds the scan
/// under way: a newer query stops it at the process boundary rather than letting
/// it finish and throw the rows away, and an older request that arrives after the
/// newer one has taken the slot is refused before Git is asked. There is no
/// queue, because a queued search is a second answer to a question no view is
/// asking any more.
#[derive(Default)]
pub struct SearchState {
    lane: Mutex<Option<Claim>>,
}

/// A search's hold on the lane, given back when its window comes back — every
/// path out of the read hands it back, including the refused ones.
pub struct Ticket<'a> {
    lane: &'a SearchState,
    claim: Claim,
}

impl SearchState {
    /// Claims the lane for one window of one query.
    ///
    /// `query_id` comes from the caller and only ever means "which keystroke";
    /// what makes it safe to compare is the session it travels with, because a
    /// second repository starts the count over while the first one's scan may
    /// still be running.
    pub fn begin(&self, session_id: u64, query_id: u64) -> Result<Ticket<'_>, ProbeError> {
        let mut lane = crate::util::guard(&self.lane);
        if let Some(claim) = lane.as_ref() {
            if claim.session_id == session_id {
                match query_id.cmp(&claim.query_id) {
                    std::cmp::Ordering::Less => {
                        return Err(ProbeError::new(
                            "search_superseded",
                            "A newer search is already running here, so this one's answer is not wanted.",
                        ))
                    }
                    std::cmp::Ordering::Equal => {
                        // The next window of a scan under way. It keeps the
                        // flag already in the lane: a continuation that
                        // cancelled the lane would cancel the scan it is
                        // continuing.
                        return Ok(Ticket {
                            lane: self,
                            claim: Claim {
                                session_id,
                                query_id,
                                cancelled: claim.cancelled.clone(),
                            },
                        });
                    }
                    std::cmp::Ordering::Greater => {}
                }
            }
            // A newer query in this session, or any query in a different one:
            // what is in the lane is answering a question no view is asking, so
            // it is stopped where it stands rather than run to the end.
            claim.cancelled.store(true, Ordering::Relaxed);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *lane = Some(Claim {
            session_id,
            query_id,
            cancelled: cancelled.clone(),
        });
        Ok(Ticket {
            lane: self,
            claim: Claim {
                session_id,
                query_id,
                cancelled,
            },
        })
    }
}

impl Ticket<'_> {
    fn cancelled(&self) -> &AtomicBool {
        self.claim.cancelled.as_ref()
    }

    /// Frees the lane only if it still holds this claim. A newer query replaced
    /// it mid-read, and clearing that would hand a third search a free lane
    /// while the second is still walking the history.
    fn finish(self) {
        let mut lane = crate::util::guard(&self.lane.lane);
        if lane.as_ref().is_some_and(|claim| {
            claim.session_id == self.claim.session_id && claim.query_id == self.claim.query_id
        }) {
            *lane = None;
        }
    }
}

/// The commit a scan walks: the one the session was published with, or, when the
/// snapshot names none — a bare repository, where Git reports no status — the
/// one `HEAD` resolves to. `HEAD` itself never reaches argv: what does is the
/// full object id read back from it, so a head that names no commit is refused
/// here rather than in the log, and no revspec ever comes from a string the user
/// typed.
///
/// The anchor read carries the query's own cancellation flag, so a keystroke
/// that overtakes this query abandons the process instead of waiting for an
/// answer nobody asked for any more.
fn search_rev(
    directory: &Path,
    head: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<String, ProbeError> {
    if let Some(rev) = head {
        if !valid_oid(rev) {
            return Err(ProbeError::new(
                "search_target_invalid",
                "A search reads one commit's history, named by its full id.",
            ));
        }
        return Ok(rev.to_owned());
    }
    let mut command = repo::user_git_command(directory);
    command.args(["rev-parse", "--verify", "HEAD"]);
    let output = runner::run_with_limit(
        command,
        cancelled,
        Duration::ZERO,
        Duration::from_secs(30),
        SEARCH_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if !output.status.success() {
        return Err(ProbeError::new(
            "search_head_unresolved",
            "This repository's HEAD names no commit, so no history was searched.",
        ));
    }
    // Truncation needs no branch of its own: a cut answer is not a complete
    // object id, and the check below refuses it.
    let rev = String::from_utf8_lossy(output.stdout.trim_ascii())
        .trim()
        .to_owned();
    if !valid_oid(&rev) {
        return Err(ProbeError::new(
            "search_protocol_error",
            "Git did not answer with a single commit id; refusing to search a history from it.",
        ));
    }
    Ok(rev)
}

/// One window of one search, bound to the session that asked for it.
///
/// The context is what makes this more than [`scan`] with a `query_id` glued on:
/// a search is bound to the history its offsets count through, so an answer from
/// a closed session or a superseded head is refused before the walk starts, in
/// the same words every other repository read uses. The query lane is the rest:
/// two windows of one query share one cancellation flag, and a query that
/// arrived after a newer one never reaches Git.
pub fn page(
    sessions: &session::SessionState,
    lane: &SearchState,
    asked: session::ReadContext,
    query_id: u64,
    query: &str,
    cursor: u64,
) -> Result<session::SessionRead<SearchPage>, ProbeError> {
    let (identity, answered) = sessions.bind_read(asked, session::ReadDomain::Graph)?;
    let ticket = lane.begin(answered.session_id, query_id)?;
    let outcome = page_inner(sessions, &identity, &ticket, query, cursor, answered);
    ticket.finish();
    outcome
}

fn page_inner(
    sessions: &session::SessionState,
    identity: &repo::RepoIdentity,
    ticket: &Ticket<'_>,
    query: &str,
    cursor: u64,
    answered: session::ReadContext,
) -> Result<session::SessionRead<SearchPage>, ProbeError> {
    let directory = if identity.is_bare {
        identity.git_dir.as_path()
    } else {
        identity
            .work_dir()
            .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))?
    };
    let view = sessions
        .current_view()
        .ok_or_else(|| ProbeError::new("read_no_session", "No repository is open."))?;
    let head = sessions.pinned_head();
    // Timed on its own because it is the one part of a window that is a process
    // rather than a walk: a snapshot that names no head — a bare repository —
    // costs a `rev-parse` per window, where the normal path reads a number the
    // session already holds.
    let rev_start = Instant::now();
    let rev = search_rev(directory, head.as_deref(), ticket.cancelled())?;
    perf::mark("search.head", rev_start.elapsed());
    let window = scan(directory, &rev, query, cursor, ticket.cancelled())?;
    Ok(session::SessionRead::new(
        answered,
        SearchPage {
            query_id: ticket.claim.query_id,
            head: rev,
            refs_generation: view.refs_generation,
            window,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;
    use std::process::{Command, Stdio};

    /// Isolated like every other fixture in this crate: no system config, no
    /// global config, no prompt, no CRLF rewrite, and fixed identities.
    fn git(repo: &Path, args: &[&str]) {
        let status = command(repo, args)
            .stdin(Stdio::null())
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn command(repo: &Path, args: &[&str]) -> Command {
        let mut command = Command::new("git");
        command
            .arg("-c")
            .arg("core.autocrlf=false")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_AUTHOR_NAME", "guit test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "guit test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
        command
    }

    fn oid(repo: &Path, rev: &str) -> String {
        let output = command(repo, &["rev-parse", rev])
            .stdin(Stdio::null())
            .output()
            .expect("git");
        assert!(output.status.success(), "{rev} names nothing");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    /// A linear history written in one `fast-import` run, oldest first, each
    /// commit a second later than the last. The increasing committer dates are
    /// why this helper exists instead of a loop of `git commit`: a fixture whose
    /// commits share one second cannot say which one is newer, and "newest
    /// first" is the very rule these tests read.
    fn import(repo: &Path, branch: &str, commits: &[(String, String)]) {
        let mut child = command(repo, &["fast-import", "--quiet", "--done"])
            .stdin(Stdio::piped())
            .spawn()
            .expect("fast-import");
        {
            let stdin = child.stdin.as_mut().expect("stdin");
            for (index, (author, message)) in commits.iter().enumerate() {
                let timestamp = 1_700_000_000 + index as u64;
                // The message already ends in a newline, and `data` is counted in
                // bytes: one more line break here is the commit terminator, so the
                // file change that follows is read as a top-level command.
                let body = format!("{message}\n");
                write!(
                    stdin,
                    "commit refs/heads/{branch}\n\
                     committer {author} <{author}@example.invalid> {timestamp} +0000\n\
                     data {}\n{body}",
                    body.len()
                )
                .expect("write");
                // One byte of one file: an empty commit is legal, but a history
                // with a tree in it is the one a real panel walks.
                let lane = index.to_string();
                write!(
                    stdin,
                    "M 100644 inline lane\ndata {}\n{lane}\n\n",
                    lane.len()
                )
                .expect("write");
            }
            writeln!(stdin, "done").expect("write");
        }
        let status = child.wait().expect("fast-import");
        assert!(status.success(), "fast-import failed");
    }

    /// The five-commit fixture most tests read: `head` is its pinned commit,
    /// `newest` the branch label no other test needs.
    struct Fixture {
        root: tempfile::TempDir,
        head: String,
    }

    impl Fixture {
        fn new(commits: &[(String, String)]) -> Fixture {
            let root = tempfile::tempdir().expect("tempdir");
            git(root.path(), &["init", "--quiet", "--initial-branch=main"]);
            import(root.path(), "main", commits);
            let head = oid(root.path(), "HEAD");
            Fixture { root, head }
        }

        fn dir(&self) -> &Path {
            self.root.path()
        }
    }

    fn five() -> Fixture {
        Fixture::new(&[
            (
                "guit test".to_owned(),
                "修复登录 crash\n\nthe body mentions a zebra".to_owned(),
            ),
            (
                "guit test".to_owned(),
                "Add retry to the push lane".to_owned(),
            ),
            (
                "Quillon Smith".to_owned(),
                "document the fold policy".to_owned(),
            ),
            (
                "guit test".to_owned(),
                "Prepare the release lane\n\nemoji 🔥 then crash".to_owned(),
            ),
            ("guit test".to_owned(), "Refactor the graph lane".to_owned()),
        ])
    }

    fn scan_at(fixture: &Fixture, query: &str, cursor: u64) -> Result<SearchWindow, ProbeError> {
        scan(
            fixture.dir(),
            &fixture.head,
            query,
            cursor,
            &AtomicBool::new(false),
        )
    }

    fn fields(window: &SearchWindow) -> Vec<(String, HitField, fuzzy::Tier)> {
        window
            .commits
            .iter()
            .map(|commit| {
                (
                    commit.oid[0..7].to_owned(),
                    commit.hits[0].field,
                    commit.hits[0].tier,
                )
            })
            .collect()
    }

    /// Every fragment of every hit slices out the text the query was matched
    /// against, in both addressings. This is the check that a hit means
    /// something to a renderer: an offset pair that lands on half a cluster is
    /// a bug no assertion about ranking would catch.
    fn assert_offsets_index(text: &str, hit: &Hit) {
        for fragment in &hit.fragments {
            let sliced = &text[fragment.byte_start..fragment.byte_end];
            let units: Vec<u16> = text.encode_utf16().collect();
            let from_units = &units[fragment.unit_start..fragment.unit_end];
            let from_bytes: Vec<u16> = sliced.encode_utf16().collect();
            assert_eq!(
                from_units,
                from_bytes,
                "byte pair {}..{} and unit pair {}..{} disagree about {:?}",
                fragment.byte_start,
                fragment.byte_end,
                fragment.unit_start,
                fragment.unit_end,
                hit.field
            );
            assert!(!sliced.is_empty(), "a fragment that covers nothing");
        }
    }

    #[test]
    fn the_subject_and_the_body_are_two_labels_on_one_text() {
        let fixture = five();
        let subject = scan_at(&fixture, "登录", 0).expect("subject");
        assert_eq!(
            fields(&subject),
            vec![(
                subject.commits[0].oid[0..7].to_owned(),
                HitField::Subject,
                fuzzy::Tier::Contiguous
            )]
        );
        let body = scan_at(&fixture, "zebra", 0).expect("body");
        assert_eq!(body.commits.len(), 1);
        assert_eq!(body.commits[0].hits[0].field, HitField::Body);
        // The body hit is addressed inside `message`, which is also where the
        // subject line sits: one string, one coordinate system.
        let hit = &body.commits[0].hits[0];
        assert_offsets_index(&body.commits[0].message, hit);
        let (bytes, units) = subject_bounds(&body.commits[0].message);
        assert_eq!(&body.commits[0].message[..bytes], "修复登录 crash");
        assert_eq!(body.commits[0].subject_end_bytes, bytes);
        assert_eq!(body.commits[0].subject_end_units, units);
    }

    #[test]
    fn a_commit_id_is_resolved_and_never_scored() {
        let fixture = five();
        let wanted = fixture.head.clone();
        let prefix = &wanted[..10];
        let found = scan_at(&fixture, prefix, 0).expect("id");
        let hit = &found.commits[0];
        assert_eq!(hit.oid, wanted);
        assert_eq!(hit.hits[0].field, HitField::Oid);
        assert_eq!(hit.hits[0].tier, fuzzy::Tier::Prefix);
        assert_eq!(hit.hits[0].fragments[0].byte_end, prefix.len());
        // The full id is the field, so the whole thing is one exact fragment.
        let whole = scan_at(&fixture, &wanted, 0).expect("full id");
        assert_eq!(whole.commits[0].hits[0].tier, fuzzy::Tier::Exact);
        // A run of hex that is not a prefix of anything is not an id hit; the
        // rest of the search still runs.
        let miss = "0123456789abcdef";
        let none = scan_at(&fixture, miss, 0).expect("no id");
        assert!(none
            .commits
            .iter()
            .all(|commit| !commit.hits.iter().any(|hit| hit.field == HitField::Oid)));
    }

    #[test]
    fn a_short_run_of_hex_is_not_read_as_an_id() {
        let fixture = five();
        // Six characters, and a prefix of the very id the test below would
        // match at seven: the shorter form stays prose, because `deadbe`-style
        // words are likelier than abbreviations and an id hit outranks them all.
        let six = &fixture.head[..6];
        let window = scan_at(&fixture, six, 0).expect("six hex");
        assert!(
            window
                .commits
                .iter()
                .all(|commit| !commit.hits.iter().any(|hit| hit.field == HitField::Oid)),
            "{six} is below the id floor and must not be an id hit"
        );
    }

    #[test]
    fn one_commit_reports_every_field_that_matched() {
        // A commit is searched as three fields — its id, its message, its author
        // name — and one query may answer in more than one of them. `qui` sits in
        // this commit's subject line and in its author name, and in nothing else
        // in the history.
        let fixture = Fixture::new(&[
            (
                "guit test".to_owned(),
                "Add retry to the push lane".to_owned(),
            ),
            (
                "Quillon Smith".to_owned(),
                "Quiet the watcher while a write runs".to_owned(),
            ),
        ]);
        let window = scan_at(&fixture, "qui", 0).expect("qui");
        assert_eq!(window.commits.len(), 1, "one commit answers, twice");
        let with_both = &window.commits[0];
        assert_eq!(
            with_both
                .hits
                .iter()
                .map(|hit| hit.field)
                .collect::<Vec<_>>(),
            vec![HitField::Subject, HitField::Author],
            "best field first, with the author match kept visible"
        );
        // Each fragment is addressed inside the field it matched, not inside one
        // joined string: these two texts differ in length and in content.
        assert_offsets_index(&with_both.message, &with_both.hits[0]);
        assert_offsets_index(&with_both.author_name, &with_both.hits[1]);
        // A message is one field, matched once. The subject/body split labels the
        // same answer two ways and never reports the same run of text twice.
        assert!(with_both.hits.iter().all(|hit| hit.field != HitField::Body));
    }

    #[test]
    fn a_field_beats_a_better_tier_in_a_lesser_field() {
        let fixture = five();
        // `lane` is an exact-run contiguous hit in two subjects, and sits inside
        // the oldest commit's body text too; the subject answers come first no
        // matter how good the body match is.
        let window = scan_at(&fixture, "lane", 0).expect("lane");
        let order = fields(&window);
        assert!(
            order
                .iter()
                .all(|(_, field, _)| *field == HitField::Subject),
            "{order:?}: every answer here is a subject match"
        );
        assert_eq!(window.commits.len(), 3);
        // The author field exists and is last: `Quillon` is nobody's subject.
        let author = scan_at(&fixture, "Quillon", 0).expect("author");
        assert_eq!(author.commits.len(), 1);
        assert_eq!(author.commits[0].hits[0].field, HitField::Author);
        assert_offsets_index(&author.commits[0].author_name, &author.commits[0].hits[0]);
    }

    #[test]
    fn equal_matches_keep_the_history_order_newest_first() {
        let fixture = Fixture::new(
            &(0..6)
                .map(|index| {
                    (
                        "guit test".to_owned(),
                        format!("lane {index} settles the graph"),
                    )
                })
                .collect::<Vec<_>>(),
        );
        let window = scan_at(&fixture, "settles", 0).expect("all");
        let offsets = window
            .commits
            .iter()
            .map(|commit| commit.offset)
            .collect::<Vec<_>>();
        assert_eq!(offsets, vec![0, 1, 2, 3, 4, 5], "newest first, by position");
        assert_eq!(window.commits[0].message, "lane 5 settles the graph");
        assert_eq!(window.scanned, 6);
        assert!(window.complete);
        assert_eq!(window.next_cursor, None);
    }

    #[test]
    fn both_addressings_point_at_the_same_run_of_text() {
        let fixture = five();
        // The emoji is two UTF-16 units and four bytes, so a hit after it has
        // byte offsets the JavaScript string would not understand.
        let window = scan_at(&fixture, "crash", 0).expect("crash");
        let after = window
            .commits
            .iter()
            .find(|commit| commit.message.contains("🔥"))
            .expect("the emoji commit");
        let hit = after
            .hits
            .iter()
            .find(|hit| hit.fragments[0].byte_start > 0)
            .expect("a hit past the start");
        assert_ne!(
            hit.fragments[0].byte_start, hit.fragments[0].unit_start,
            "an astral character between the query and the start is the case \
             the two addressings exist for"
        );
        assert_offsets_index(&after.message, hit);
        let (bytes, units) = subject_bounds(&after.message);
        assert_eq!(
            after.message[..bytes].encode_utf16().count(),
            units,
            "the subject boundary is a number in both addressings too"
        );
    }

    #[test]
    fn names_are_matched_and_their_kind_is_named() {
        let root = tempfile::tempdir().expect("tempdir");
        let repo = root.path();
        git(repo, &["init", "--quiet", "--initial-branch=main"]);
        let commits: Vec<(String, String)> = (0..3)
            .map(|index| ("guit test".to_owned(), format!("lane {index} settles")))
            .collect();
        import(repo, "main", &commits);
        // A branch on the current history, a tag on an older commit of it, and
        // a root no revision of `main` reaches.
        let head = oid(repo, "HEAD");
        let middle = oid(repo, "HEAD~1");
        git(repo, &["branch", "login-fix", &head]);
        git(repo, &["tag", "v1.2", &middle]);
        import(
            repo,
            "orphan-work",
            &[("guit test".to_owned(), "nothing here connects".to_owned())],
        );
        let window = scan(repo, &head, "login-fix", 0, &AtomicBool::new(false)).expect("branch");
        assert_eq!(window.refs.len(), 1);
        let name = &window.refs[0];
        assert_eq!(name.kind, RefKind::Branch);
        assert_eq!(name.name, "login-fix");
        assert_eq!(name.commit_oid.as_deref(), Some(head.as_str()));
        assert_eq!(
            name.reached_from_head,
            Some(true),
            "the pinned commit itself needs no probe"
        );
        assert_offsets_index(&name.name, &ref_hit_as_hit(name));

        let outside = scan(repo, &head, "orphan", 0, &AtomicBool::new(false)).expect("orphan");
        assert_eq!(outside.refs.len(), 1);
        assert_eq!(
            outside.refs[0].reached_from_head,
            Some(false),
            "a name outside this history is proved by a probe that ran"
        );
        let tag = scan(repo, &head, "v1.2", 0, &AtomicBool::new(false)).expect("tag");
        assert_eq!(tag.refs[0].kind, RefKind::Tag);
        assert_eq!(tag.refs[0].reached_from_head, Some(true));
    }

    fn ref_hit_as_hit(name: &RefHit) -> Hit {
        Hit {
            field: HitField::Subject,
            tier: name.tier,
            fragments: name.fragments.clone(),
        }
    }

    #[test]
    fn a_query_that_is_not_a_query_is_refused() {
        let fixture = five();
        let long = "a".repeat(MAX_QUERY_CHARS + 1);
        for (query, code) in [
            ("", "search_query_empty"),
            ("   \t\n ", "search_query_empty"),
            (long.as_str(), "search_query_too_long"),
        ] {
            let error = scan_at(&fixture, query, 0).expect_err("refused");
            assert_eq!(error.code.as_str(), code, "for query {query:?}");
        }
        // A revision that is not a full object id never reaches argv.
        for rev in ["HEAD", "main", "HEAD~5", "../elsewhere", "0000"] {
            let error =
                scan(fixture.dir(), rev, "crash", 0, &AtomicBool::new(false)).expect_err("refused");
            assert_eq!(
                error.code.as_str(),
                "search_target_invalid",
                "for rev {rev:?}"
            );
        }
    }

    #[test]
    fn a_truncated_window_is_refused_and_nothing_is_parsed() {
        let fixture = five();
        let error = read_window(
            fixture.dir(),
            &fixture.head,
            0,
            WINDOW_RECORDS + SPARE_RECORDS,
            32,
            &AtomicBool::new(false),
        )
        .expect_err("a 32-byte bound cannot hold five records");
        assert_eq!(error.code.as_str(), "search_truncated");
    }

    #[test]
    fn a_record_that_is_not_the_promised_shape_is_not_parsed() {
        // Three fields where four were asked for: the message would be read out
        // of the author's bytes.
        assert!(split_record(b"dead\x1fbeef\x1fauthor").is_none());
        // An id that is not an id, whatever the field count: every offset below
        // it would be measured against something Git never named.
        assert!(split_record(b"not-hex\x1fdate\x1fauthor\x1fmessage\n\x00").is_none());
        // The shape that is accepted keeps the message whole and its trailing
        // newline gone.
        let record = split_record(
            b"0123456789abcdef0123456789abcdef01234567\x1f2026-01-01T00:00:00+00:00\x1fQuillon\x1fsubject\n\nbody\n",
        )
        .expect("four fields");
        assert_eq!(record.message, "subject\n\nbody");
        assert_eq!(record.author_name, "Quillon");
    }

    #[test]
    fn a_cancellation_is_a_cancellation_and_not_an_empty_answer() {
        let fixture = five();
        let cancelled = AtomicBool::new(true);
        let error = scan(fixture.dir(), &fixture.head, "crash", 0, &cancelled).expect_err("stops");
        assert_eq!(error.code.as_str(), "process_cancelled");
    }

    // --- windows over a history longer than any page the panel holds ---------

    /// A history of `count` commits in which `needle` appears only at
    /// `positions`, so a scan that stops early cannot find it and one that
    /// completes must. A position is an offset in scan order — "how many commits
    /// back from the pinned head" — because that is the number a window reports;
    /// the stream is written oldest first, so the messages are handed over in the
    /// opposite order from the one the scan walks.
    fn deep(count: u64, positions: &[u64], needle: &str) -> Fixture {
        let mut by_offset: Vec<String> = (0..count)
            .map(|offset| {
                if positions.contains(&offset) {
                    format!("lane {offset} settles and carries {needle}")
                } else {
                    format!("lane {offset} settles the graph")
                }
            })
            .collect();
        by_offset.reverse();
        Fixture::new(
            &by_offset
                .into_iter()
                .map(|message| ("guit test".to_owned(), message))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn a_commit_the_panel_has_never_loaded_is_found() {
        // One thousand and fifty commits back — twenty-one pages of the graph's
        // own 50-row page, none of which the panel has on screen, and past the
        // first window's thousand.
        let fixture = deep(1_200, &[1_050], "深水区");
        let first = scan_at(&fixture, "深水区", 0).expect("window 0");
        assert_eq!(first.scanned, WINDOW_RECORDS);
        assert!(first.commits.is_empty(), "the match is beyond this window");
        assert!(!first.complete);
        // The same scan, continuing: the answer is found in the second window
        // and carries its position, which is the number a view needs to say
        // "21 pages down" without a second read.
        let second =
            scan_at(&fixture, "深水区", first.next_cursor.expect("cursor")).expect("window 1");
        assert_eq!(second.commits.len(), 1);
        assert_eq!(second.commits[0].offset, 1_050);
        assert!(second.complete);
        assert_eq!(second.commits[0].hits[0].tier, fuzzy::Tier::Contiguous);
        assert_offsets_index(&second.commits[0].message, &second.commits[0].hits[0]);
    }

    #[test]
    fn an_empty_window_while_the_scan_runs_is_not_no_results() {
        // The acceptance in its sharpest shape: a query nothing in the first
        // window matches. A view that rendered "no results" here would be
        // wrong, and only `complete` can tell it not to.
        let fixture = deep(2_400, &[2_399], "quuxonly");
        let first = scan_at(&fixture, "quuxonly", 0).expect("window 0");
        assert!(first.commits.is_empty());
        assert!(!first.complete, "the history is not covered yet");
        assert_eq!(first.next_cursor, Some(WINDOW_RECORDS));
        assert_eq!(
            first.stopped_by, None,
            "it stopped for the window, not a limit"
        );
        let second =
            scan_at(&fixture, "quuxonly", first.next_cursor.expect("cursor")).expect("window 1");
        assert!(second.commits.is_empty());
        assert_eq!(second.next_cursor, Some(2 * WINDOW_RECORDS));
        let third =
            scan_at(&fixture, "quuxonly", second.next_cursor.expect("cursor")).expect("window 2");
        assert_eq!(third.commits.len(), 1, "found at the oldest commit");
        assert!(third.complete);
        assert_eq!(third.next_cursor, None);
        // And a query nothing matches at all, once the scan has finished, is
        // the only state that may be worded as no results.
        let mut window = scan_at(&fixture, "nothinglikethis", 0).expect("first");
        assert!(window.commits.is_empty(), "an empty first window");
        while let Some(next) = window.next_cursor {
            window = scan_at(&fixture, "nothinglikethis", next).expect("next");
            assert!(window.commits.is_empty());
        }
        assert!(window.complete, "the scan says it covered the history");
    }

    #[test]
    fn windows_tile_the_history_without_gaps_or_repeats() {
        let fixture = deep(2_500, &[], "unused");
        let mut cursor = 0;
        let mut windows = Vec::new();
        loop {
            let window = scan_at(&fixture, "settles", cursor).expect("window");
            let offsets: Vec<u64> = window.commits.iter().map(|hit| hit.offset).collect();
            windows.push((cursor, window.scanned, window.complete, offsets));
            let Some(next) = window.next_cursor else {
                break;
            };
            cursor = next;
        }
        // Every window reports the cap it granted, and the oldest is the short
        // one that says the history ended.
        let scanned: Vec<u64> = windows.iter().map(|entry| entry.1).collect();
        assert_eq!(scanned, vec![1_000, 1_000, 500]);
        assert!(windows.last().expect("last").2, "the last window completes");
        // A capped window returns its best hundred, in scan order, and says
        // more matched than it sent. Each window's offsets start where its own
        // cursor did — a gap or a repeat here is the pagination being wrong.
        for (index, window) in windows.iter().take(2).enumerate() {
            let offsets = &window.3;
            assert_eq!(offsets.len(), MAX_WINDOW_COMMITS, "window {index}");
            let expected: Vec<u64> = (window.0..window.0 + MAX_WINDOW_COMMITS as u64).collect();
            assert_eq!(
                offsets, &expected,
                "newest first, with no gap inside the cap"
            );
        }
    }

    #[test]
    fn a_capped_window_asks_for_a_narrower_query_not_another_page() {
        // `hits_truncated` and `complete` are different claims and the fixture
        // separates them: 2,500 matching commits, a window of 1,000, a cap of
        // 100. The window sends its best hundred, the scan continues, and only
        // the final window can say the history is covered.
        let fixture = deep(2_500, &[], "unused");
        let first = scan_at(&fixture, "settles", 0).expect("capped");
        assert!(first.hits_truncated);
        assert_eq!(first.commits.len(), MAX_WINDOW_COMMITS);
        assert!(!first.complete);
        assert_eq!(first.next_cursor, Some(WINDOW_RECORDS));
        let last = {
            let mut cursor = WINDOW_RECORDS;
            loop {
                let window = scan_at(&fixture, "settles", cursor).expect("later");
                if window.complete {
                    break window;
                }
                cursor = window.next_cursor.expect("cursor");
            }
        };
        assert!(last.complete);
        assert_eq!(last.scanned, 500);
        assert!(last.hits_truncated, "the oldest window is capped too");
    }

    #[test]
    fn the_scan_cap_stops_a_walk_and_says_so() {
        // Asking beyond the ceiling is refused with the reason the ceiling is
        // the reason, and never with an empty list that looks like an answer.
        let fixture = five();
        let error = scan_at(&fixture, "crash", MAX_SCANNED_RECORDS + 1).expect_err("beyond");
        assert_eq!(error.code.as_str(), STOP_SCAN_CAP);
        // At the ceiling the read is still allowed, and a five-commit history
        // answers it with the end of the history: an empty window that says it
        // covered everything, which is the only window allowed to be worded as
        // no results.
        let at = scan_at(&fixture, "crash", MAX_SCANNED_RECORDS).expect("at the ceiling");
        assert_eq!(at.scanned, 0, "the ceiling is far past this history's end");
        assert!(
            at.complete,
            "a read that reaches the end is a finished scan"
        );
        assert_eq!(at.next_cursor, None, "nothing is left to ask");
        assert_eq!(
            at.stopped_by, None,
            "the history ended, the ceiling did not"
        );
        assert!(at.commits.is_empty());
    }

    #[test]
    fn names_are_read_once_and_their_cap_is_its_own() {
        let commits: Vec<(String, String)> = (0..1_200)
            .map(|index| ("guit test".to_owned(), format!("lane {index} settles")))
            .collect();
        let fixture = Fixture::new(&commits);
        // One more name than the listing may send, so the window that is capped
        // by ref count is distinguishable from the one capped by commit count.
        let names = MAX_WINDOW_REFS + 10;
        for index in 0..names {
            git(
                fixture.dir(),
                &["branch", &format!("feature-{index}-lane"), &fixture.head],
            );
        }
        let first = scan_at(&fixture, "lane", 0).expect("first");
        assert_eq!(
            first.refs.len(),
            MAX_WINDOW_REFS,
            "the name list is capped by its own ceiling"
        );
        assert_eq!(
            first.commits.len(),
            MAX_WINDOW_COMMITS,
            "and is not counted against the ceiling the commits are capped by"
        );
        assert!(first.refs.iter().all(|name| name.kind == RefKind::Branch));
        let second = scan_at(&fixture, "lane", first.next_cursor.expect("cursor")).expect("second");
        assert!(
            second.refs.is_empty(),
            "the listing is asked once, and does not move while the history is walked"
        );
        assert!(
            second.complete,
            "two hundred records left, one window covers them"
        );
    }

    #[test]
    fn a_batch_of_two_thousand_records_is_matched_in_windows_that_fit_the_budget() {
        // The scan-side half of the input budget: the first window must be
        // answered well inside 500 ms, warm, on this host. Printed because a
        // number in an assertion that could never fail is a number nobody
        // reads; the bound below is loose enough to survive a loaded machine
        // and tight enough to catch a quadratic regression.
        let fixture = deep(2_000, &[1_999], "rareneedle");
        let mut warm = Vec::new();
        for _ in 0..9 {
            let started = Instant::now();
            let window = scan_at(&fixture, "rareneedle", 0).expect("warm first window");
            warm.push(started.elapsed());
            assert!(!window.complete, "the first window is one of three");
        }
        warm.sort();
        let median = warm[warm.len() / 2];
        let started = Instant::now();
        let mut cursor = 0;
        let mut hits = 0;
        loop {
            let window = scan_at(&fixture, "rareneedle", cursor).expect("scan");
            hits += window.commits.len();
            let Some(next) = window.next_cursor else {
                assert!(window.complete);
                break;
            };
            cursor = next;
        }
        let whole = started.elapsed();
        assert_eq!(hits, 1, "one commit carries the needle");
        // The other half of the same decision, and the one that sets the window
        // width rather than the timeout: how many bytes a thousand records
        // actually carry. A window that filled the capture bound would be
        // refused, so the bound has to hold a message far larger than this
        // fixture's average, not merely this average.
        let bytes = read_window(
            fixture.dir(),
            &fixture.head,
            0,
            WINDOW_RECORDS + SPARE_RECORDS,
            SEARCH_OUTPUT_LIMIT,
            &AtomicBool::new(false),
        )
        .expect("raw window");
        println!(
            "search E02 warm first window p50 {:?}, full {}-commit scan {:?}, first window {} bytes of an {SEARCH_OUTPUT_LIMIT}-byte bound ({} build)",
            median,
            2_000,
            whole,
            bytes.len(),
            if cfg!(debug_assertions) { "unoptimized" } else { "release" },
        );
        assert!(
            bytes.len() * 8 < SEARCH_OUTPUT_LIMIT,
            "a window this wide leaves less than an eighth of the bound"
        );
        assert!(
            median.as_millis() < 700,
            "a warm first window took {median:?} on this host"
        );
        assert!(whole.as_millis() < 4_000, "the whole scan took {whole:?}");
    }

    // --- the context a search is asked with, and the lane it runs in ----------

    /// A session over a fixture, with the exact number pair its own published
    /// snapshot ships — what a view carries, and therefore what these tests ask
    /// with. Nothing here invents an identity out of the fields it renders.
    struct Opened {
        fixture: Fixture,
        state: session::SessionState,
        view: session::SnapshotView,
        asked: session::ReadContext,
    }

    fn open_session(fixture: Fixture) -> Opened {
        let state = session::SessionState::default();
        let view = session::open(&state, fixture.dir()).expect("open");
        let asked = context(&view);
        Opened {
            fixture,
            state,
            view,
            asked,
        }
    }

    /// The pair a view carries: this session, this history. A search asks with
    /// it and answers with it, and nothing here derives it from the rows.
    fn context(view: &session::SnapshotView) -> session::ReadContext {
        session::ReadContext {
            session_id: view.session_id,
            generation: Some(view.history_generation),
        }
    }

    /// A bare repository holding a real history: no work tree, so no snapshot
    /// branch, and the only commit a search can stand on is the one `HEAD`
    /// resolves to.
    struct Bare {
        root: tempfile::TempDir,
        dir: std::path::PathBuf,
        head: String,
    }

    fn bare_fixture(commits: &[(String, String)]) -> Bare {
        let root = tempfile::tempdir().expect("tempdir");
        let dir = root.path().join("bare");
        std::fs::create_dir(&dir).expect("mkdir");
        git(
            &dir,
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        import(&dir, "main", commits);
        let head = oid(&dir, "HEAD");
        Bare { root, dir, head }
    }

    fn search(
        state: &session::SessionState,
        asked: session::ReadContext,
        lane: &SearchState,
        query_id: u64,
        query: &str,
    ) -> Result<session::SessionRead<SearchPage>, ProbeError> {
        page(state, lane, asked, query_id, query, 0)
    }

    #[test]
    fn a_search_answers_under_the_context_it_was_asked_with() {
        let opened = open_session(five());
        let lane = SearchState::default();
        let answer = search(&opened.state, opened.asked, &lane, 1, "lane").expect("page");
        // The echo is the whole mechanism: a reply that does not carry the
        // context back cannot be recognised as stale by anything reading it.
        assert_eq!(answer.context, opened.asked);
        assert_eq!(answer.value.query_id, 1);
        // The anchor is the commit the snapshot was published with, not the text
        // `HEAD`, so an offset in the answer names one history and no other.
        assert_eq!(answer.value.head, opened.fixture.head);
        assert_eq!(answer.value.refs_generation, opened.view.refs_generation);
        assert!(!answer.value.window.commits.is_empty());
        // The window came back, so the lane is empty again: a search that
        // finished leaves no claim behind to refuse the next keystroke.
        assert!(crate::util::guard(&lane.lane).is_none());
    }

    #[test]
    fn a_search_for_a_closed_session_is_refused_before_git_is_asked() {
        let opened = open_session(five());
        let lane = SearchState::default();
        session::close(&opened.state);
        let error = search(&opened.state, opened.asked, &lane, 1, "lane").expect_err("closed");
        assert_eq!(error.code.as_str(), "read_no_session");
        // A refusal is not a scan result: no rows, and the lane untouched.
        assert!(crate::util::guard(&lane.lane).is_none());
    }

    #[test]
    fn a_search_bound_to_a_superseded_history_is_refused() {
        let opened = open_session(five());
        let lane = SearchState::default();
        // The head moves, which is the one thing that makes every offset in a
        // search answer mean something else. An empty commit is the cheapest
        // way to move a tip without touching what the scan reads: `fast-import`
        // in a second run starts a fresh branch and refuses to clobber the old
        // tip, so it is the wrong tool for "the head moved since you looked".
        git(
            opened.fixture.dir(),
            &["commit", "--quiet", "--allow-empty", "-m", "a"],
        );
        let moved = session::refresh(&opened.state)
            .expect("refresh")
            .expect("session open");
        assert!(
            moved.history_generation > opened.view.history_generation,
            "the head moved but the generation this search is bound to did not"
        );
        let error = search(&opened.state, opened.asked, &lane, 2, "lane").expect_err("stale");
        assert_eq!(error.code.as_str(), "read_stale_context");
        // Asking again with the live context is a search, not a retry of a
        // failure: the new answer is anchored on the new commit.
        let asked = context(&moved);
        let answer = search(&opened.state, asked, &lane, 3, "lane").expect("fresh");
        assert_eq!(answer.value.head, oid(opened.fixture.dir(), "HEAD"));
        assert_ne!(answer.value.head, opened.fixture.head);
    }

    #[test]
    fn a_query_that_arrived_after_a_newer_one_never_reaches_git() {
        let opened = open_session(five());
        let lane = SearchState::default();
        let running = lane.begin(opened.view.session_id, 3).expect("claim");
        let error = search(&opened.state, opened.asked, &lane, 2, "lane").expect_err("superseded");
        assert_eq!(error.code.as_str(), "search_superseded");
        // Refusing the late request is the cheap half. Stopping the scan that is
        // already walking a thousand records is the part that saves the read:
        // the running query owns the lane, and an older request cannot take its
        // cancellation flag away from it.
        assert!(!running.cancelled().load(Ordering::Relaxed));
    }

    #[test]
    fn a_newer_query_stops_the_scan_under_way_at_the_process_boundary() {
        let opened = open_session(five());
        let lane = SearchState::default();
        let first = lane.begin(opened.view.session_id, 1).expect("first");
        let second = lane.begin(opened.view.session_id, 2).expect("second");
        assert!(first.cancelled().load(Ordering::Relaxed));
        // The stopped scan reports that it was stopped. It is not an empty
        // answer, and a view rendering one would say "nothing matched" about a
        // search that was cut off.
        let error = scan(
            opened.fixture.dir(),
            &opened.fixture.head,
            "crash",
            0,
            first.cancelled(),
        )
        .expect_err("cancelled");
        assert_eq!(error.code.as_str(), "process_cancelled");
        // The newer query still holds the lane, so the older window coming back
        // late cannot free it.
        drop(first);
        assert!(crate::util::guard(&lane.lane)
            .as_ref()
            .is_some_and(|claim| claim.query_id == 2));
        drop(second);
    }

    #[test]
    fn two_windows_of_one_query_share_one_cancellation() {
        let opened = open_session(five());
        let lane = SearchState::default();
        let first = lane.begin(opened.view.session_id, 4).expect("first window");
        let second = lane
            .begin(opened.view.session_id, 4)
            .expect("second window");
        assert!(Arc::ptr_eq(&first.claim.cancelled, &second.claim.cancelled));
        assert!(!second.cancelled().load(Ordering::Relaxed));
    }

    #[test]
    fn a_second_repository_starts_its_own_count() {
        let first = open_session(five());
        let second =
            Fixture::new(&[("guit test".to_owned(), "Refactor the graph lane".to_owned())]);
        let second_view = session::open(&first.state, second.dir()).expect("open second");
        assert_ne!(first.view.session_id, second_view.session_id);
        let lane = SearchState::default();
        let old = lane.begin(first.view.session_id, 9).expect("old session");
        // Opening a repository restarts the keystroke count at one. Read as a
        // number on its own that is older than nine; read together with the
        // session it belongs to, it is a different search box over a different
        // repository, and the scan it replaces is one nothing is waiting for.
        let fresh = lane
            .begin(second_view.session_id, 1)
            .expect("a new session outranks no old one");
        assert!(old.cancelled().load(Ordering::Relaxed));
        let asked = context(&second_view);
        let answer = search(&first.state, asked, &lane, 1, "lane").expect("page");
        assert_eq!(answer.context, asked);
        assert_eq!(answer.value.head, second.head);
        assert!(!fresh.cancelled().load(Ordering::Relaxed));
    }

    #[test]
    fn a_bare_repository_is_searched_from_the_commit_its_head_names() {
        let bare = bare_fixture(&[("guit test".to_owned(), "Refactor the graph lane".to_owned())]);
        let state = session::SessionState::default();
        let view = session::open(&state, &bare.dir).expect("open bare");
        // Git reports no status in a bare repository, so the snapshot names no
        // branch and the session pins no head. The search still has an anchor:
        // the commit `HEAD` resolves to, read back as a full id.
        assert!(view.branch.is_none());
        let lane = SearchState::default();
        let answer = search(&state, context(&view), &lane, 1, "lane").expect("bare page");
        assert_eq!(answer.value.head, bare.head);
        assert!(!answer.value.window.commits.is_empty());
        assert_eq!(answer.value.window.commits[0].offset, 0);
    }

    #[test]
    fn a_head_that_names_no_commit_is_a_refusal_with_a_reason() {
        let root = tempfile::tempdir().expect("tempdir");
        let dir = root.path().join("empty");
        std::fs::create_dir(&dir).expect("mkdir");
        git(
            &dir,
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        // The read is refused with the reason Git gave, never as a history in
        // which nothing matched.
        let error = search_rev(&dir, None, &AtomicBool::new(false)).expect_err("no commit");
        assert_eq!(error.code.as_str(), "search_head_unresolved");
    }
}
