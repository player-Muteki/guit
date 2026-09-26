// Failure classification for network operations. The verdict
// is a heuristic suggestion layer only: guit keeps Git's redacted original
// stderr in `details` and the exit code untouched, and never rewrites the
// message around a guessed cause. Unknown failures report Other honestly.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NetCategory {
    Auth,
    Network,
    NonFastForward,
    ProtectedBranch,
    RemoteHookRejected,
    StaleLease,
    NotFound,
    Other,
}

impl NetCategory {
    /// Fixed advice per category: different failures get
    /// different, concrete suggestions; Other never pretends to know).
    pub(crate) fn suggestion(self) -> &'static str {
        match self {
            NetCategory::Auth => {
                "Git could not authenticate. Check your credential manager or \
                                  SSH agent, then retry (optionally with credentials)."
            }
            NetCategory::Network => {
                "The remote could not be reached. Check connectivity and the \
                                     remote URL, then fetch again."
            }
            NetCategory::NonFastForward => {
                "The remote has commits you do not have locally. Fetch \
                                            first and integrate (pull) before pushing again; \
                                            do not force unless you mean to overwrite."
            }
            NetCategory::ProtectedBranch => {
                "The remote protects this branch and refused the \
                                             update. Review its branch-protection policy; guit \
                                             will not work around it."
            }
            NetCategory::RemoteHookRejected => {
                "A server-side hook on the remote refused the \
                                                update. Expand the details and read the remote's \
                                                verdict; it is the remote's rule, not guit's."
            }
            NetCategory::StaleLease => {
                "The remote moved since your last fetch, so the \
                                       force-with-lease guard refused the push. Fetch first to \
                                       see what changed; do not overwrite unseen commits."
            }
            NetCategory::NotFound => {
                "The remote or branch was not found. Verify the remote URL \
                                      and branch name, or fetch to refresh tracking refs."
            }
            NetCategory::Other => {
                "Unrecognized failure; expand the raw (redacted) output for \
                                   the remote's own words."
            }
        }
    }
}

/// (needle, category) in declaration order; needles are lowercase. On a tie
/// at the same position the earlier declaration wins, so Auth outranks the
/// generic network phrasing on prompt-disabled lines.
const PATTERNS: &[(&str, NetCategory)] = &[
    ("could not read username", NetCategory::Auth),
    ("authentication failed", NetCategory::Auth),
    ("permission denied (publickey)", NetCategory::Auth),
    ("terminal prompts disabled", NetCategory::Auth),
    ("invalid username or password", NetCategory::Auth),
    ("http basic: access denied", NetCategory::Auth),
    ("returned error: 401", NetCategory::Auth),
    ("returned error: 403", NetCategory::Auth),
    ("returned error: 407", NetCategory::Auth),
    ("no supported authentication methods", NetCategory::Auth),
    ("stale info", NetCategory::StaleLease),
    ("force-with-lease", NetCategory::StaleLease),
    ("hook declined", NetCategory::RemoteHookRejected),
    ("pre-receive hook", NetCategory::RemoteHookRejected),
    ("update-ref failed", NetCategory::RemoteHookRejected),
    ("protected branch", NetCategory::ProtectedBranch),
    ("gh006", NetCategory::ProtectedBranch),
    ("you are not allowed to push", NetCategory::ProtectedBranch),
    ("non-fast-forward", NetCategory::NonFastForward),
    ("fetch first", NetCategory::NonFastForward),
    ("fast-forward", NetCategory::NonFastForward),
    ("not found", NetCategory::NotFound),
    (
        "does not appear to be a git repository",
        NetCategory::NotFound,
    ),
    ("repository not found", NetCategory::NotFound),
    ("returned error: 404", NetCategory::NotFound),
    ("could not resolve host", NetCategory::Network),
    ("connection refused", NetCategory::Network),
    ("connection reset", NetCategory::Network),
    // Measured on Git 2.53: refused loopback connections report the curl
    // wording, which stays English even when Git's own prefix localizes.
    ("failed to connect", NetCategory::Network),
    ("could not connect", NetCategory::Network),
    ("timed out", NetCategory::Network),
    ("timeout", NetCategory::Network),
    ("rpc failed", NetCategory::Network),
    ("the remote end hung up", NetCategory::Network),
    ("network is unreachable", NetCategory::Network),
    ("ssl connect error", NetCategory::Network),
    ("certificate verification failed", NetCategory::Network),
    ("recv failure", NetCategory::Network),
];

/// Classifies a failed network command's raw stderr. Redaction runs first,
/// per line, so a secret that happens to contain a pattern can never move
/// the verdict; ANSI color sequences and CR line endings are stripped
/// because progress output carries both. The pattern that occurs earliest
/// in the cleaned text wins.
pub(crate) fn classify(raw_stderr: &[u8]) -> NetCategory {
    let stripped = strip_ansi(&String::from_utf8_lossy(raw_stderr));
    let cleaned: Vec<String> = stripped
        .lines()
        .map(|line| crate::probe::redact(line).to_lowercase())
        .collect();
    let mut best: Option<((usize, usize), NetCategory)> = None;
    for (pattern, category) in PATTERNS {
        for (index, line) in cleaned.iter().enumerate() {
            let Some(column) = line.find(*pattern) else {
                continue;
            };
            let position = (index, column);
            if best.is_none_or(|(best_position, _)| position < best_position) {
                best = Some((position, *category));
            }
            break;
        }
    }
    best.map(|(_, category)| category)
        .unwrap_or(NetCategory::Other)
}

/// Removes ANSI CSI sequences (`ESC [ params … final-byte`) that Git's
/// --progress output embeds, without pulling in a regex dependency.
fn strip_ansi(text: &str) -> String {
    if !text.contains('\x1b') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if matches!(c, '@'..='~') {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn category(stderr: &str) -> NetCategory {
        classify(stderr.as_bytes())
    }

    #[test]
    fn canned_fixtures_reach_every_category() {
        // Measured shapes from Git 2.53 plus public-host boilerplate.
        assert_eq!(
            category("fatal: could not read Username for 'https://example.com': No such device or address"),
            NetCategory::Auth
        );
        assert_eq!(
            category("git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository."),
            NetCategory::Auth
        );
        assert_eq!(
            category(
                "fatal: unable to access 'https://x.invalid/y/': Could not resolve host: x.invalid"
            ),
            NetCategory::Network
        );
        assert_eq!(
            category("error: RPC failed; curl 28 Failed to connect to github.com port 443 after 130153 ms: Timed out"),
            NetCategory::Network
        );
        // Measured shape of a refused loopback clone (Git 2.53 + curl):
        // Git's prefix localizes, curl's verdict does not.
        assert_eq!(
            category("fatal: \u{65e0}\u{6cd5}\u{8bbf}\u{95ee} 'http://127.0.0.1:1/nope.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Could not connect to server"),
            NetCategory::Network
        );
        assert_eq!(
            category(" ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs"),
            NetCategory::NonFastForward
        );
        assert_eq!(
            category("remote: Resolving deltas: 100% (1/1), done.\n ! [rejected]        main -> main (fetch first)"),
            NetCategory::NonFastForward
        );
        assert_eq!(
            category("remote: error: GH006: Protected branch update failed for refs/heads/main."),
            NetCategory::ProtectedBranch
        );
        assert_eq!(
            category("remote: error: hook declined to update refs/heads/main\n ! [remote rejected] main -> main (hook declined)"),
            NetCategory::RemoteHookRejected
        );
        assert_eq!(
            category(" ! [rejected]        main -> main (stale info)"),
            NetCategory::StaleLease
        );
        assert_eq!(
            category("ERROR: Repository not found.\nfatal: Could not read from remote repository."),
            NetCategory::NotFound
        );
        assert_eq!(
            category("the input device is not a TTY\nsomething entirely unrelated"),
            NetCategory::Other
        );
    }

    #[test]
    fn a_secret_containing_a_pattern_cannot_steer_the_verdict() {
        // The token in the URL redacts to [redacted] *before* matching,
        // so its embedded "fetch first" text never reaches the classifier;
        // the leftover line matches nothing and the verdict stays Other.
        let line = "fatal: unable to access \
                    'https://user:tok-fetch-first-token@github.com/o/r': server said hello";
        assert_eq!(category(line), NetCategory::Other);
        assert!(!crate::probe::redact(line).contains("tok-fetch-first-token"));
    }

    #[test]
    fn earliest_occurrence_wins_across_categories() {
        // A prompt-disabled auth line comes before the trailing non-FF
        // rejection: auth (the actionable cause) is classified.
        let text =
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n\
                    ! [rejected] main -> main (non-fast-forward)";
        assert_eq!(category(text), NetCategory::Auth);
        // The same patterns in the opposite order flip the verdict.
        let flipped = "! [rejected] main -> main (non-fast-forward)\n\
                       fatal: could not read Username for 'https://github.com': terminal prompts disabled";
        assert_eq!(category(flipped), NetCategory::NonFastForward);
    }

    #[test]
    fn crlf_and_ansi_color_noise_is_cleaned_before_matching() {
        let text = "\x1b[m\r * [rejected]        main -> main (fetch first)\x1b[0m\r\n";
        assert_eq!(category(text), NetCategory::NonFastForward);
    }

    #[test]
    fn suggestions_are_fixed_per_category_and_other_is_honest() {
        assert!(NetCategory::Auth
            .suggestion()
            .contains("credential manager or SSH agent"));
        assert!(NetCategory::Other.suggestion().contains("Unrecognized"));
        for category in [
            NetCategory::Auth,
            NetCategory::Network,
            NetCategory::NonFastForward,
            NetCategory::ProtectedBranch,
            NetCategory::RemoteHookRejected,
            NetCategory::StaleLease,
            NetCategory::NotFound,
            NetCategory::Other,
        ] {
            assert!(!category.suggestion().is_empty());
        }
    }

    #[test]
    fn category_words_are_pinned_on_the_wire() {
        let encode =
            |category: NetCategory| serde_json::to_string(&category).expect("category serializes");
        assert_eq!(encode(NetCategory::Auth), "\"auth\"");
        assert_eq!(encode(NetCategory::NonFastForward), "\"nonfastforward\"");
        assert_eq!(
            encode(NetCategory::RemoteHookRejected),
            "\"remotehookrejected\""
        );
        assert_eq!(encode(NetCategory::StaleLease), "\"stalelease\"");
        assert_eq!(encode(NetCategory::ProtectedBranch), "\"protectedbranch\"");
        assert_eq!(encode(NetCategory::NotFound), "\"notfound\"");
        assert_eq!(encode(NetCategory::Network), "\"network\"");
        assert_eq!(encode(NetCategory::Other), "\"other\"");
    }
}

#[cfg(test)]
mod stress {
    use super::*;

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

    fn category(stderr: &str) -> NetCategory {
        classify(stderr.as_bytes())
    }

    #[test]
    fn twenty_thousand_random_garbage_inputs_never_panic() {
        let mut rng = Rng(0xDEADBEEF12345678);
        for _ in 0..20000 {
            let length = rng.below(512);
            let bytes: Vec<u8> = (0..length)
                .map(|_| match rng.below(8) {
                    0 => b'\x1b',
                    1 => b'\r',
                    2 => b'\n',
                    3 => 0,
                    4 => b'\xf0',
                    5 => 0x80 + rng.below(64) as u8,
                    6 => b'A' + rng.below(26) as u8,
                    _ => rng.below(128) as u8,
                })
                .collect();
            let _ = classify(&bytes);
        }
    }

    #[test]
    fn every_pattern_survives_uppercase_and_ansi_noise() {
        for (pattern, expected) in PATTERNS {
            let text = format!("\x1b[31m{pattern}\x1b[0m\r\n");
            let upper = format!("\x1b[31m{}\x1b[0m\r\n", pattern.to_uppercase());
            assert_eq!(category(&text), *expected, "lowercase {pattern}");
            assert_eq!(category(&upper), *expected, "uppercase {pattern}");
        }
    }

    #[test]
    fn patterns_split_across_lines_do_not_match() {
        assert_eq!(category("timed\nout"), NetCategory::Other);
        assert_eq!(category("non-fast-\nforward"), NetCategory::Other);
        assert_eq!(category("could not\nresolve host"), NetCategory::Other);
    }

    #[test]
    fn a_one_megabyte_log_with_the_verdict_last_still_classifies() {
        let mut text = "x".repeat(1024 * 1024);
        text.push('\n');
        text.push_str("remote: error: GH006: Protected branch update failed.");
        let started = std::time::Instant::now();
        assert_eq!(category(&text), NetCategory::ProtectedBranch);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn bare_escapes_and_control_sequences_do_not_panic() {
        assert_eq!(category("\x1b"), NetCategory::Other);
        assert_eq!(category("\x1b["), NetCategory::Other);
        assert_eq!(category("\x1b[K"), NetCategory::Other);
        // An unterminated CSI swallows everything after it…
        assert_eq!(
            category("\x1b[38;5;1connection refused"),
            NetCategory::Other,
            "text behind an unterminated CSI is eaten — git never emits one, pinned as behaviour"
        );
        // …but text before the escape still classifies.
        assert_eq!(
            category("connection refused \x1b[38;5;1"),
            NetCategory::Network
        );
        // OSC (window-title) sequences are NOT stripped: the ESC and one
        // following byte die, the body survives and can steer the verdict.
        // Git's --progress output uses only CSI; this documents the limit.
        assert_eq!(
            category("\x1b]0;fetch first\u{7}"),
            NetCategory::NonFastForward,
            "OSC body is passed through to matching"
        );
    }

    #[test]
    fn first_line_position_beats_pattern_declaration_order() {
        // "stale info" (StaleLease) sits on line 2 before nothing; a
        // Network phrase on line 1 wins by earliest occurrence.
        let text =
            "fatal: could not resolve host: x.invalid\n ! [rejected] main -> main (stale info)";
        assert_eq!(category(text), NetCategory::Network);
        let flipped =
            " ! [rejected] main -> main (stale info)\nfatal: could not resolve host: x.invalid";
        assert_eq!(category(flipped), NetCategory::StaleLease);
    }
}
