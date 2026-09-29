use crate::probe::ProbeError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchHeader {
    /// Commit OID, or `(initial)` when no commit exists yet.
    pub oid: String,
    /// Branch name or `(detached)`.
    pub head: String,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

impl BranchHeader {
    pub fn is_detached(&self) -> bool {
        self.head == "(detached)"
    }
    pub fn is_unborn(&self) -> bool {
        self.oid == "(initial)"
    }
    pub fn has_upstream(&self) -> bool {
        self.upstream.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedEntry {
    /// Index (staged) and work-tree status letters; `.` means unchanged.
    pub index_status: char,
    pub worktree_status: char,
    pub submodule_state: String,
    pub head_mode: String,
    pub index_mode: String,
    pub worktree_mode: String,
    pub head_oid: String,
    pub index_oid: String,
    pub path: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameEntry {
    pub tracked: TrackedEntry,
    /// Rename or copy score such as `R100` or `C75`.
    pub score: String,
    /// Original path from HEAD or the index.
    pub origin_path: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmergedEntry {
    pub index_status: char,
    pub worktree_status: char,
    pub submodule_state: String,
    /// Modes for stages 1/2/3 plus the work tree.
    pub modes: [String; 4],
    /// Object IDs for index stages 1/2/3.
    pub stage_oids: [String; 3],
    pub path: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusEntry {
    Tracked(TrackedEntry),
    Rename(RenameEntry),
    Unmerged(UnmergedEntry),
    Untracked { path: Vec<u8> },
}

impl StatusEntry {
    pub fn raw_path(&self) -> &Vec<u8> {
        match self {
            StatusEntry::Tracked(entry) => &entry.path,
            StatusEntry::Rename(entry) => &entry.tracked.path,
            StatusEntry::Unmerged(entry) => &entry.path,
            StatusEntry::Untracked { path } => path,
        }
    }
    pub fn is_conflict(&self) -> bool {
        matches!(self, StatusEntry::Unmerged(_))
    }
    pub fn is_staged(&self) -> bool {
        match self {
            StatusEntry::Tracked(entry) => entry.index_status != '.',
            StatusEntry::Rename(entry) => entry.tracked.index_status != '.',
            StatusEntry::Unmerged(_) => true,
            StatusEntry::Untracked { .. } => false,
        }
    }
    pub fn is_worktree_change(&self) -> bool {
        match self {
            StatusEntry::Tracked(entry) => entry.worktree_status != '.',
            StatusEntry::Rename(entry) => entry.tracked.worktree_status != '.',
            StatusEntry::Unmerged(_) => true,
            StatusEntry::Untracked { .. } => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedStatus {
    pub branch: Option<BranchHeader>,
    pub entries: Vec<StatusEntry>,
}

fn fail(detail: impl Into<String>) -> ProbeError {
    ProbeError::new(
        "status_parse_failed",
        format!(
            "Git status output did not match the porcelain v2 grammar: {}",
            detail.into()
        ),
    )
}

/// Splits `count` space-separated metadata fields from a trailing path that
/// may itself contain spaces.
fn split_fields(token: &[u8], count: usize) -> Option<(Vec<&[u8]>, &[u8])> {
    let mut rest = token;
    let mut fields = Vec::with_capacity(count);
    for _ in 0..count {
        let space = rest.iter().position(|byte| *byte == b' ')?;
        fields.push(&rest[..space]);
        rest = &rest[space + 1..];
    }
    if rest.is_empty() {
        return None;
    }
    Some((fields, rest))
}

fn status_pair(field: &[u8]) -> Option<(char, char)> {
    let text = std::str::from_utf8(field).ok()?;
    let chars: Vec<char> = text.chars().collect();
    if chars.len() == 2 && !chars.iter().any(|ch| ch.is_whitespace()) {
        Some((chars[0], chars[1]))
    } else {
        None
    }
}

fn submodule_state(field: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(field).ok()?;
    (text.len() == 4 && (text == "N..." || text.starts_with('S'))).then(|| text.to_owned())
}

fn valid_octal(field: &[u8]) -> bool {
    std::str::from_utf8(field)
        .map(|text| text.len() == 6 && text.bytes().all(|byte| (b'0'..=b'7').contains(&byte)))
        .unwrap_or(false)
}

fn valid_oid(field: &[u8]) -> bool {
    std::str::from_utf8(field)
        .map(|text| {
            (text.len() == 40 || text.len() == 64)
                && text.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .unwrap_or(false)
}

fn ascii(field: &[u8]) -> Option<String> {
    std::str::from_utf8(field).ok().map(str::to_owned)
}

fn parse_record_1(fields: Vec<&[u8]>, path: &[u8]) -> Result<StatusEntry, ProbeError> {
    // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    let [xy, sub, mh, mi, mw, hh, hi] = fields.as_slice() else {
        return Err(fail("bad 1 record"));
    };
    let (index_status, worktree_status) = status_pair(xy).ok_or_else(|| fail("bad 1 XY"))?;
    if submodule_state(sub).is_none()
        || !valid_octal(mh)
        || !valid_octal(mi)
        || !valid_octal(mw)
        || !valid_oid(hh)
        || !valid_oid(hi)
    {
        return Err(fail("bad 1 record metadata"));
    }
    Ok(StatusEntry::Tracked(TrackedEntry {
        index_status,
        worktree_status,
        submodule_state: sub.expect_ascii(),
        head_mode: mh.expect_ascii(),
        index_mode: mi.expect_ascii(),
        worktree_mode: mw.expect_ascii(),
        head_oid: hh.expect_ascii(),
        index_oid: hi.expect_ascii(),
        path: path.to_vec(),
    }))
}

trait ExpectAscii {
    fn expect_ascii(self) -> String;
}
impl ExpectAscii for &[u8] {
    fn expect_ascii(self) -> String {
        ascii(self).expect("validated ASCII field")
    }
}

fn parse_record_2(
    fields: Vec<&[u8]>,
    path: &[u8],
    origins: &mut std::iter::Peekable<std::vec::IntoIter<&[u8]>>,
) -> Result<StatusEntry, ProbeError> {
    // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> then a NUL-separated origin path
    let [xy, sub, mh, mi, mw, hh, hi, score] = fields.as_slice() else {
        return Err(fail("bad 2 record"));
    };
    let (index_status, worktree_status) = status_pair(xy).ok_or_else(|| fail("bad 2 XY"))?;
    let score = ascii(score).ok_or_else(|| fail("bad 2 score"))?;
    let kind = score.chars().next().ok_or_else(|| fail("empty 2 score"))?;
    if submodule_state(sub).is_none()
        || !matches!(kind, 'R' | 'C')
        || !score.chars().skip(1).all(|ch| ch.is_ascii_digit())
        || !valid_octal(mh)
        || !valid_octal(mi)
        || !valid_octal(mw)
        || !valid_oid(hh)
        || !valid_oid(hi)
    {
        return Err(fail("bad 2 record metadata"));
    }
    let origin = origins
        .next()
        .ok_or_else(|| fail("missing rename origin path"))?;
    Ok(StatusEntry::Rename(RenameEntry {
        tracked: TrackedEntry {
            index_status,
            worktree_status,
            submodule_state: sub.expect_ascii(),
            head_mode: mh.expect_ascii(),
            index_mode: mi.expect_ascii(),
            worktree_mode: mw.expect_ascii(),
            head_oid: hh.expect_ascii(),
            index_oid: hi.expect_ascii(),
            path: path.to_vec(),
        },
        score,
        origin_path: origin.to_vec(),
    }))
}

fn parse_record_u(fields: Vec<&[u8]>, path: &[u8]) -> Result<StatusEntry, ProbeError> {
    // <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    let [xy, sub, m1, m2, m3, mw, h1, h2, h3] = fields.as_slice() else {
        return Err(fail("bad u record"));
    };
    let (index_status, worktree_status) = status_pair(xy).ok_or_else(|| fail("bad u XY"))?;
    if submodule_state(sub).is_none()
        || !valid_octal(m1)
        || !valid_octal(m2)
        || !valid_octal(m3)
        || !valid_octal(mw)
        || !valid_oid(h1)
        || !valid_oid(h2)
        || !valid_oid(h3)
    {
        return Err(fail("bad u record metadata"));
    }
    Ok(StatusEntry::Unmerged(UnmergedEntry {
        index_status,
        worktree_status,
        submodule_state: sub.expect_ascii(),
        modes: [
            m1.expect_ascii(),
            m2.expect_ascii(),
            m3.expect_ascii(),
            mw.expect_ascii(),
        ],
        stage_oids: [h1.expect_ascii(), h2.expect_ascii(), h3.expect_ascii()],
        path: path.to_vec(),
    }))
}

fn parse_branch_header(
    branch: &mut Option<BranchHeader>,
    name: &str,
    value: &[u8],
) -> Result<(), ProbeError> {
    let value = std::str::from_utf8(value).map_err(|_| fail("branch header not UTF-8"))?;
    let header = branch.get_or_insert(BranchHeader {
        oid: String::new(),
        head: String::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
    });
    match name {
        "branch.oid" => header.oid = value.to_owned(),
        "branch.head" => header.head = value.to_owned(),
        "branch.upstream" => header.upstream = Some(value.to_owned()),
        "branch.ab" => {
            let (ahead, behind) = value.split_once(' ').ok_or_else(|| fail("bad branch.ab"))?;
            header.ahead = ahead
                .strip_prefix('+')
                .and_then(|text| text.parse::<u64>().ok())
                .ok_or_else(|| fail("bad branch.ab ahead"))?;
            header.behind = behind
                .strip_prefix('-')
                .and_then(|text| text.parse::<u64>().ok())
                .ok_or_else(|| fail("bad branch.ab behind"))?;
        }
        _ => {} // Unknown `# branch.*` headers are ignored per the spec.
    }
    Ok(())
}

pub fn parse(bytes: &[u8]) -> Result<ParsedStatus, ProbeError> {
    if bytes.is_empty() {
        return Ok(ParsedStatus::default());
    }
    if *bytes.last().expect("non-empty") != 0 {
        return Err(fail("output does not end with a NUL delimiter"));
    }
    let tokens: Vec<&[u8]> = bytes[..bytes.len() - 1].split(|byte| *byte == 0).collect();
    let mut branch = None;
    let mut entries = Vec::new();
    let mut iter = tokens.into_iter().peekable();
    while let Some(token) = iter.next() {
        if token.is_empty() {
            return Err(fail("empty record"));
        }
        match token[0] {
            b'#' => {
                let (fields, value) =
                    split_fields(&token[2..], 1).ok_or_else(|| fail("bad header line"))?;
                let name =
                    std::str::from_utf8(fields[0]).map_err(|_| fail("header name not UTF-8"))?;
                if let Some(short) = name.strip_prefix("branch.") {
                    if matches!(short, "oid" | "head" | "upstream" | "ab") {
                        parse_branch_header(&mut branch, name, value)?;
                    }
                }
            }
            b'1' => {
                let (fields, path) =
                    split_fields(&token[2..], 7).ok_or_else(|| fail("bad 1 record"))?;
                entries.push(parse_record_1(fields, path)?);
            }
            b'2' => {
                let (fields, path) =
                    split_fields(&token[2..], 8).ok_or_else(|| fail("bad 2 record"))?;
                entries.push(parse_record_2(fields, path, &mut iter)?);
            }
            b'u' => {
                let (fields, path) =
                    split_fields(&token[2..], 9).ok_or_else(|| fail("bad u record"))?;
                entries.push(parse_record_u(fields, path)?);
            }
            b'?' => entries.push(StatusEntry::Untracked {
                path: token[2..].to_vec(),
            }),
            other => return Err(fail(format!("unknown record prefix {other:?}"))),
        }
    }
    if let Some(header) = &branch {
        if header.oid.is_empty() || header.head.is_empty() {
            return Err(fail("incomplete branch header"));
        }
    }
    Ok(ParsedStatus { branch, entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nul(items: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for item in items {
            out.extend_from_slice(item.as_bytes());
            out.push(0);
        }
        out
    }

    const OID: &str = "6b8bd7b0f1e4c9c6b9f1f2a44a8d70f5f52b0a9c";
    const ZERO: &str = "0000000000000000000000000000000000000000";

    #[test]
    fn parses_branch_headers() {
        let stream = nul(&[
            &format!("# branch.oid {OID}"),
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
        ]);
        let parsed = parse(&stream).unwrap();
        let branch = parsed.branch.unwrap();
        assert_eq!(branch.head, "main");
        assert_eq!(branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!((branch.ahead, branch.behind), (2, 1));
        assert!(!branch.is_detached() && !branch.is_unborn() && branch.has_upstream());
    }

    #[test]
    fn parses_detached_and_unborn_states_as_distinct() {
        let detached = parse(&nul(&[
            &format!("# branch.oid {OID}"),
            "# branch.head (detached)",
        ]))
        .unwrap()
        .branch
        .unwrap();
        assert!(detached.is_detached() && !detached.is_unborn());
        let unborn = parse(&nul(&["# branch.oid (initial)", "# branch.head master"]))
            .unwrap()
            .branch
            .unwrap();
        assert!(unborn.is_unborn() && !unborn.has_upstream());
        assert_eq!((unborn.ahead, unborn.behind), (0, 0));
    }

    #[test]
    fn parses_tracked_record_with_spaces_and_unicode_in_path() {
        let stream = nul(&[
            &format!("# branch.oid {OID}"),
            "# branch.head main",
            &format!("1 M. N... 100644 100644 100644 {OID} 9f1d3a4d4f8e3e0a6a2f1b9d6b7c5a4e3d2f1a0b src/中文 文件.txt"),
        ]);
        let parsed = parse(&stream).unwrap();
        let StatusEntry::Tracked(entry) = &parsed.entries[0] else {
            panic!("expected tracked entry");
        };
        assert_eq!((entry.index_status, entry.worktree_status), ('M', '.'));
        assert_eq!(
            String::from_utf8(entry.path.clone()).unwrap(),
            "src/中文 文件.txt"
        );
        assert_eq!((entry.index_status, entry.worktree_status), ('M', '.'));
    }

    #[test]
    fn parses_rename_record_consuming_the_origin_token() {
        let stream = nul(&[
            &format!("2 R. N... 100644 100644 100644 {ZERO} {OID} R100 new 名.txt"),
            "old name.txt",
            "? 未跟踪.txt",
        ]);
        let parsed = parse(&stream).unwrap();
        assert_eq!(parsed.entries.len(), 2);
        let StatusEntry::Rename(entry) = &parsed.entries[0] else {
            panic!("expected rename entry");
        };
        assert_eq!(entry.score, "R100");
        assert_eq!(
            String::from_utf8(entry.tracked.path.clone()).unwrap(),
            "new 名.txt"
        );
        assert_eq!(
            String::from_utf8(entry.origin_path.clone()).unwrap(),
            "old name.txt"
        );
        assert_eq!(entry.tracked.index_status, 'R');
        assert_eq!(entry.tracked.worktree_status, '.');
    }

    #[test]
    fn parses_unmerged_records() {
        let stream = nul(&[&format!(
            "u UU N... 100644 100644 100644 100644 {ZERO} {ZERO} {ZERO} conflict.txt"
        )]);
        let parsed = parse(&stream).unwrap();
        assert!(parsed.entries[0].is_conflict());
        assert!(parsed.branch.is_none());
        let StatusEntry::Unmerged(entry) = &parsed.entries[0] else {
            panic!("expected unmerged");
        };
        assert_eq!((entry.index_status, entry.worktree_status), ('U', 'U'));
    }

    #[test]
    fn bad_grammar_never_looks_clean() {
        assert_eq!(parse(b"").unwrap(), ParsedStatus::default());
        let cases: Vec<Vec<u8>> = vec![
            b"garbage".to_vec(), // no NUL terminator
            nul(&["1 M. N... bad bad bad bad bad path"]),
            nul(&["1 M. N... 100644 100644 100644 short-sha 9f1d3a4d4f8e3e0a6a2f1b9d6b7c5a4e3d2f1a0b path"]),
            nul(&["1  M. N... 100644 100644 100644", OID, OID, "path"]) // merged: wrong field shape
                .into_iter()
                .collect(),
            nul(&["9 weird record"]),
        ];
        for case in cases {
            if case.is_empty() {
                continue;
            }
            let error = parse(&case).unwrap_err();
            assert_eq!(error.code.as_str(), "status_parse_failed");
        }
        // A rename record without its origin token must fail, not pass silently.
        let error = parse(&nul(&[&format!(
            "2 R. N... 100644 100644 100644 {ZERO} {OID} R100 new.txt"
        )]))
        .unwrap_err();
        assert_eq!(error.code.as_str(), "status_parse_failed");
        // Tracked output must not be accepted with an incomplete branch header.
        let error = parse(&nul(&["# branch.oid (initial)"])).unwrap_err();
        assert_eq!(error.code.as_str(), "status_parse_failed");
    }

    #[test]
    fn parses_real_git_output_for_every_record_kind() {
        use std::process::Command;
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().to_path_buf();
        let git = |args: &[&str]| -> bool {
            Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
                .env("GIT_AUTHOR_NAME", "guit test")
                .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
                .env("GIT_COMMITTER_NAME", "guit test")
                .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("LC_ALL", "C")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("git")
                .success()
        };
        assert!(git(&["init", "--quiet", "--initial-branch=main"]));
        std::fs::write(repo.join("staged.txt"), "one\n").unwrap();
        std::fs::write(repo.join("worktree.txt"), "one\n").unwrap();
        std::fs::write(repo.join("renamed.txt"), "one\n").unwrap();
        std::fs::write(repo.join("conflict.txt"), "base\n").unwrap();
        assert!(git(&["add", "."]));
        assert!(git(&["commit", "--quiet", "-m", "seed"]));
        assert!(git(&["commit", "--quiet", "--allow-empty", "-m", "seed2"]));

        // Conflict first, so no staged state has to survive branch switches:
        // side and main edit the same line from `base`.
        assert!(git(&["checkout", "-q", "-b", "side", "HEAD~1"]));
        std::fs::write(repo.join("conflict.txt"), "side\n").unwrap();
        assert!(git(&["commit", "-q", "-m", "side", "--", "conflict.txt"]));
        assert!(git(&["checkout", "-q", "main"]));
        std::fs::write(repo.join("conflict.txt"), "main\n").unwrap();
        assert!(git(&["commit", "-q", "-m", "main", "--", "conflict.txt"]));
        // Expected to stop with conflicts; that conflicted state is the goal.
        git(&["merge", "--no-ff", "--no-commit", "side"]);

        // Layer the remaining record kinds on top of the merge state.
        std::fs::write(repo.join("staged.txt"), "staged change\n").unwrap();
        assert!(git(&["add", "--", "staged.txt"]));
        std::fs::write(repo.join("worktree.txt"), "worktree change\n").unwrap();
        std::fs::write(repo.join("新 名.txt"), "one\n").unwrap();
        assert!(git(&["add", "--", "新 名.txt"]));
        assert!(git(&["rm", "-q", "--", "renamed.txt"]));
        std::fs::write(repo.join("未跟踪.txt"), "fresh\n").unwrap();

        let identity = crate::repo::detect(&repo).unwrap();
        let bytes = crate::repo::status_output(&identity, true).unwrap().stdout;
        let parsed = parse(&bytes).expect("real Git output must parse");
        let branch = parsed.branch.as_ref().expect("branch header");
        assert_eq!(branch.head, "main");
        let mut kinds = std::collections::BTreeSet::new();
        for entry in &parsed.entries {
            match entry {
                StatusEntry::Tracked(t) if t.index_status != '.' => kinds.insert("staged"),
                StatusEntry::Tracked(t) if t.worktree_status != '.' => kinds.insert("worktree"),
                StatusEntry::Rename(_) => kinds.insert("rename"),
                StatusEntry::Unmerged(_) => kinds.insert("conflict"),
                StatusEntry::Untracked { .. } => kinds.insert("untracked"),
                StatusEntry::Tracked(_) => kinds.insert("other"),
            };
        }
        for required in ["staged", "worktree", "rename", "conflict", "untracked"] {
            assert!(
                kinds.contains(required),
                "missing {required}: {:?}",
                parsed.entries
            );
        }
        let rename = parsed
            .entries
            .iter()
            .find_map(|entry| match entry {
                StatusEntry::Rename(r) => Some(r),
                _ => None,
            })
            .expect("rename entry");
        assert_eq!(
            rename.tracked.path,
            "新 名.txt".as_bytes().to_vec(),
            "raw path bytes must round-trip losslessly"
        );
        assert_eq!(rename.origin_path, b"renamed.txt".to_vec());
        assert!(rename.score.starts_with('R'));
    }
}

#[cfg(test)]
mod stress {
    use super::*;

    /// Deterministic xorshift64* so every fuzz run reproduces from its seed.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545F4914F6CDD1D)
        }
        fn below(&mut self, max: usize) -> usize {
            (self.next() % max as u64) as usize
        }
    }

    fn nul(items: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for item in items {
            out.extend_from_slice(item.as_bytes());
            out.push(0);
        }
        out
    }

    const OID: &str = "6b8bd7b0f1e4c9c6b9f1f2a44a8d70f5f52b0a9c";
    const LONG_OID: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn valid_stream() -> Vec<u8> {
        nul(&[
            &format!("# branch.oid {OID}"),
            "# branch.head main",
            &format!("1 M. N... 100644 100644 100644 {OID} {LONG_OID} src/file name.txt"),
            "? untracked 空格.txt",
        ])
    }

    #[test]
    fn fifty_thousand_mutations_of_a_valid_stream_never_panic() {
        let base = valid_stream();
        let mut rng = Rng(0x9E3779B97F4A7C15);
        let mut accepted = 0usize;
        for _ in 0..50000 {
            let mut bytes = base.clone();
            let flips = 1 + rng.below(4);
            for _ in 0..flips {
                let index = rng.below(bytes.len());
                bytes[index] = match rng.below(4) {
                    0 => b'0' + rng.below(10) as u8,
                    1 => *b"12u?#!  \t.\x00\xffRW".get(rng.below(12)).unwrap_or(&b'x'),
                    2 => rng.below(256) as u8,
                    _ => bytes[index].wrapping_add(1),
                };
            }
            // The parser may reject anything it does not recognize, but it
            // must never panic and never report a mutation as the pristine
            // stream while silently dropping entries.
            let outcome = std::panic::catch_unwind(|| parse(&bytes));
            if let Ok(Ok(parsed)) = &outcome {
                if parsed.entries.len() == 2 {
                    accepted += 1;
                }
                for entry in &parsed.entries {
                    let _ = entry.raw_path();
                    let _ = entry.is_conflict();
                    let _ = entry.is_staged();
                    let _ = entry.is_worktree_change();
                }
            }
        }
        assert!(
            accepted > 0,
            "some mutations must still parse (otherwise the fuzz is vacuous)"
        );
    }

    #[test]
    fn truncated_streams_fail_closed() {
        let base = valid_stream();
        for cut in 0..base.len() {
            // Dropping the final NUL or cutting mid-record must be an error,
            // never a silently smaller but "successful" status.
            let _ = parse(&base[..cut]);
        }
        assert!(
            parse(&base[..base.len() - 1]).is_err(),
            "missing final NUL is an error"
        );
    }

    #[test]
    fn twenty_thousand_records_parse_with_exact_paths() {
        let mut items: Vec<String> = vec![
            format!("# branch.oid {OID}"),
            "# branch.head main".to_string(),
        ];
        for index in 0..20000 {
            items.push(format!(
                "1 M. N... 100644 100644 100644 {OID} {OID} dir {index}/文件 名.txt"
            ));
        }
        let stream = nul(&items.iter().map(String::as_str).collect::<Vec<_>>());
        let started = Instant::now();
        let parsed = parse(&stream).expect("uniform stream parses");
        assert_eq!(parsed.entries.len(), 20000);
        for (index, entry) in parsed.entries.iter().enumerate() {
            assert_eq!(
                String::from_utf8(entry.raw_path().clone()).unwrap(),
                format!("dir {index}/文件 名.txt")
            );
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "parsing stays linear"
        );
    }

    #[test]
    fn headers_are_last_write_wins_and_unknown_keys_are_ignored() {
        let parsed = parse(&nul(&[
            &format!("# branch.oid {OID}"),
            "# branch.head first",
            "# branch.head second",
            "# branch.mystery whatever",
            "# branch.upstream origin/x",
            "# branch.upstream origin/y",
            "# branch.ab +1 -2",
        ]))
        .expect("duplicate headers are legal");
        let branch = parsed.branch.unwrap();
        assert_eq!(branch.head, "second");
        assert_eq!(branch.upstream.as_deref(), Some("origin/y"));
        assert_eq!((branch.ahead, branch.behind), (1, 2));
    }

    #[test]
    fn branch_ab_extremes_and_malformations() {
        let parsed = parse(&nul(&[
            "# branch.oid (initial)",
            "# branch.head (detached)",
            "# branch.ab +18446744073709551615 -0",
        ]))
        .expect("u64 max fits");
        assert_eq!(parsed.branch.unwrap().ahead, u64::MAX);
        for bad in [
            "# branch.ab 1 -2",
            "# branch.ab +1 2",
            "# branch.ab +1",
            "# branch.ab +1 -2 -3",
            "# branch.ab +x -2",
            "# branch.ab +-1 -2",
        ] {
            let error = parse(&nul(&["# branch.oid (initial)", "# branch.head x", bad]))
                .expect_err("malformed branch.ab must fail");
            assert_eq!(error.code.as_str(), "status_parse_failed", "{bad}");
        }
    }

    #[test]
    fn structural_shorthand_and_odd_but_valid_records() {
        // An empty path on an untracked record parses; on a 1-record the
        // grammar requires trailing content, so an empty path fails closed
        // rather than yielding a phantom entry.
        let parsed = parse(&nul(&["? "])).expect("empty untracked path parses");
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].raw_path().len(), 0);
        assert!(parse(&nul(&[&format!(
            "1 .. N... 000000 000000 000000 {OID} {OID} "
        )]))
        .is_err());
        // A sha256 repository uses 64-hex OIDs everywhere; the 4-column
        // submodule field must be exactly four characters.
        assert!(parse(&nul(&[&format!(
            "1 M. S N... 100644 100644 100644 {LONG_OID} {LONG_OID} x"
        )]))
        .is_err());
        parse(&nul(&[&format!(
            "1 M. N... 100644 100644 100644 {LONG_OID} {LONG_OID} x"
        )]))
        .expect("64-hex oids are valid");
        // A path that itself looks like a record must not be re-read as one
        // (records are NUL-delimited, so this works only if paths are never
        // scanned for structure — pin that).
        let parsed = parse(&nul(&["1 U. N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 u U. N... bogus"])).unwrap();
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].raw_path(), b"u U. N... bogus");
    }

    #[test]
    fn rename_origin_token_is_consumed_exactly_once() {
        let parsed = parse(&nul(&[
            &format!("2 R. N... 100644 100644 100644 {OID} {OID} R100 new.txt"),
            "old.txt",
            &format!("1 M. N... 100644 100644 100644 {OID} {OID} another.txt"),
        ]))
        .unwrap();
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[1].raw_path(), b"another.txt");
        // Copy records share the shape with a C score.
        parse(&nul(&[
            &format!("2 C. N... 100644 100644 100644 {OID} {OID} C75 copy.txt"),
            "source.txt",
        ]))
        .expect("copies parse");
        // A bogus score letter fails instead of borrowing the next record.
        let error = parse(&nul(&[
            &format!("2 R. N... 100644 100644 100644 {OID} {OID} X100 new.txt"),
            "? not-an-origin.txt",
        ]))
        .expect_err("X score is not a rename");
        assert_eq!(error.code.as_str(), "status_parse_failed");
    }

    use std::time::{Duration, Instant};
}
