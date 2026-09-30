//! The matcher every search answer is built on: one folding policy, one tier
//! ladder, one ranking key.
//!
//! It knows nothing of Git, of the session or of any store: a candidate is a
//! string it is handed and what comes back is where the query appeared in it.
//! Two things live here rather than in a caller, because a search that
//! disagrees with itself about them is not a search:
//!
//! * When two strings count as the same. Both sides are canonically composed
//!   and case-folded per extended grapheme cluster, so an accented letter
//!   written as one code point matches the same letter written as a base plus a
//!   combining mark. Folding is not rewriting: the original string is never
//!   touched and every hit is addressed back into it.
//! * How good a match is. Exact, then prefix, then one unbroken run, then the
//!   characters in order with gaps. Within a tier, the match covering fewer
//!   clusters wins, then the one covering fewer folded code points. What comes
//!   after that — which field a hit came from, the order a commit list already
//!   has — belongs to the caller, so [`Hit::rank`] is a key, not a verdict.
//!
//! Matching happens on folded code points while every reported fragment is
//! snapped to whole clusters: a query that hits one member of a family emoji
//! highlights the entire emoji, because a renderer cannot draw half a cluster.
//!
//! The limits are asserted by tests rather than discovered by a reader:
//! canonical equivalence is not base-letter equivalence, so `ecole` does not
//! find `école`; the fold covers the places where Unicode lowercasing and
//! default case folding part company and a reader would call the difference a
//! bug, not every divergence in CaseFolding.txt; there is no pinyin,
//! translation or semantic matching. An object name is not matched here at
//! all — a commit id has to be resolved by the backend, not fuzzy-scored
//! against prose.

// The matcher is reached only by tests so far: nothing outside this file calls
// it, and the attribute goes as soon as the search lane does. Listing it here
// rather than at each item keeps the warning gate on for everything else.
#![allow(dead_code)]

use icu_normalizer::ComposingNormalizerBorrowed;
use unicode_segmentation::UnicodeSegmentation;

/// How well a query matched a field, best first. The order is the ladder: a
/// field that holds the query as one run is never reported as a subsequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    /// The field is the query.
    Exact,
    /// The field begins with the query.
    Prefix,
    /// The query appears as one unbroken run.
    Contiguous,
    /// The query's characters appear in order, with gaps.
    Subsequence,
}

/// A piece of the original string, on cluster boundaries. Both addressings are
/// the caller's: bytes slice the Rust string it came from, UTF-16 units index
/// the JavaScript string the row is drawn from, and the two differ for every
/// astral character — an emoji in a subject line is not rare.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fragment {
    pub byte_start: usize,
    pub byte_end: usize,
    pub unit_start: usize,
    pub unit_end: usize,
}

/// One match, with the pieces of the field it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub tier: Tier,
    /// In field order, never overlapping, never adjacent: a run of letters is
    /// one fragment, and `fbg` in `fix build graph` is three.
    pub fragments: Vec<Fragment>,
    clusters: u32,
    folded: usize,
}

impl Hit {
    /// The sort key for hits on the same field: tier, then how few clusters the
    /// match spans, then how few folded code points. Callers sort with a
    /// stable sort so that equal keys keep the order the candidate list
    /// already had — for commits, topological order; for refs, name order.
    pub fn rank(&self) -> (u8, usize, usize) {
        (self.tier as u8, self.clusters as usize, self.folded)
    }
}

/// A query, folded once so a scan over a hundred thousand messages folds it
/// once too. Trimming is the caller's: this file reports where a string it was
/// handed matches, and the hand that already removed the spaces gets to decide
/// what was searched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    cps: Vec<char>,
}

impl Query {
    pub fn new(input: &str) -> Self {
        let nfc = ComposingNormalizerBorrowed::new_nfc();
        let mut cps = Vec::with_capacity(input.chars().count());
        for cluster in input.graphemes(true) {
            fold_cluster(cluster, &nfc, &mut cps);
        }
        Query { cps }
    }

    /// True for the empty string and for input that folds away to nothing. An
    /// empty query is not "nothing matched": a caller must show the unfiltered
    /// list, and this says when it may not claim either.
    pub fn is_empty(&self) -> bool {
        self.cps.is_empty()
    }
}

/// A candidate field, folded and indexed by cluster so a hit can be mapped
/// back without keeping the original around.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    cps: Vec<char>,
    /// The cluster each folded code point came from, non-decreasing.
    owner: Vec<u32>,
    clusters: Vec<Fragment>,
}

impl Field {
    pub fn new(text: &str) -> Self {
        let nfc = ComposingNormalizerBorrowed::new_nfc();
        let mut field = Field {
            cps: Vec::with_capacity(text.chars().count()),
            owner: Vec::with_capacity(text.chars().count()),
            clusters: Vec::with_capacity(text.chars().count()),
        };
        let mut bytes = 0;
        let mut units = 0;
        for cluster in text.graphemes(true) {
            let index = field.clusters.len() as u32;
            let unit_len: usize = cluster.chars().map(char::len_utf16).sum();
            field.clusters.push(Fragment {
                byte_start: bytes,
                byte_end: bytes + cluster.len(),
                unit_start: units,
                unit_end: units + unit_len,
            });
            fold_cluster(cluster, &nfc, &mut field.cps);
            // Every code point this cluster produced belongs to this cluster.
            field.owner.resize(field.cps.len(), index);
            bytes += cluster.len();
            units += unit_len;
        }
        field
    }

    pub fn find(&self, query: &Query) -> Option<Hit> {
        let needle = &query.cps;
        if needle.is_empty() || needle.len() > self.cps.len() {
            return None;
        }
        let last = needle.len() - 1;
        if needle.len() == self.cps.len() && self.cps == *needle {
            return Some(self.run_hit(Tier::Exact, 0, self.cps.len() - 1));
        }
        if self.cps.starts_with(needle) {
            return Some(self.run_hit(Tier::Prefix, 0, last));
        }
        if let Some(start) = self.cps.windows(needle.len()).position(|run| run == needle) {
            return Some(self.run_hit(Tier::Contiguous, start, start + last));
        }
        self.find_subsequence(needle)
    }

    /// The first complete match, then the latest start that still completes it
    /// — the tightest window that ends earliest. Backtracking to find a
    /// narrower window that ends later would rank a hit above one a reader saw
    /// first, and it costs a search per start.
    fn find_subsequence(&self, needle: &[char]) -> Option<Hit> {
        let mut taken = 0usize;
        let mut end = None;
        for (index, cp) in self.cps.iter().enumerate() {
            if needle.get(taken) == Some(cp) {
                taken += 1;
                if taken == needle.len() {
                    end = Some(index);
                    break;
                }
            }
        }
        let end = end?;
        let mut positions = vec![0usize; needle.len()];
        let mut needed = needle.len();
        for index in (0..=end).rev() {
            if self.cps[index] == needle[needed - 1] {
                positions[needed - 1] = index;
                needed -= 1;
                if needed == 0 {
                    break;
                }
            }
        }
        Some(self.scatter_hit(Tier::Subsequence, &positions))
    }

    /// A matched run of consecutive folded code points. Their clusters are the
    /// same cluster or the next one, always, so the run is one fragment.
    fn run_hit(&self, tier: Tier, from: usize, through: usize) -> Hit {
        let (first, last) = (self.owner[from], self.owner[through]);
        Hit {
            tier,
            fragments: vec![self.span(first, last)],
            clusters: last - first + 1,
            folded: through - from + 1,
        }
    }

    /// Matched code points that are not one run, merged into the clusters they
    /// touch. Positions are ascending and hold at least one index.
    fn scatter_hit(&self, tier: Tier, positions: &[usize]) -> Hit {
        let (low, high) = (positions[0], positions[positions.len() - 1]);
        let mut fragments: Vec<Fragment> = Vec::new();
        let mut run: Option<(u32, u32)> = None;
        for &index in positions {
            let owner = self.owner[index];
            match run {
                Some((start, previous)) if owner <= previous + 1 => {
                    run = Some((start, previous.max(owner)));
                }
                Some((start, previous)) => {
                    fragments.push(self.span(start, previous));
                    run = Some((owner, owner));
                }
                None => run = Some((owner, owner)),
            }
        }
        if let Some((start, previous)) = run {
            fragments.push(self.span(start, previous));
        }
        Hit {
            tier,
            fragments,
            clusters: self.owner[high] - self.owner[low] + 1,
            folded: high - low + 1,
        }
    }

    fn span(&self, from: u32, through: u32) -> Fragment {
        let (first, last) = (
            &self.clusters[from as usize],
            &self.clusters[through as usize],
        );
        Fragment {
            byte_start: first.byte_start,
            byte_end: last.byte_end,
            unit_start: first.unit_start,
            unit_end: last.unit_end,
        }
    }
}

/// Fold one extended grapheme cluster: compose it, lowercase every code point,
/// then patch the two places where a full lowercase mapping is not what a
/// reader searching for the folded form would expect.
fn fold_cluster(cluster: &str, nfc: &ComposingNormalizerBorrowed<'_>, out: &mut Vec<char>) {
    for cp in nfc.normalize_iter(cluster.chars()) {
        for lower in cp.to_lowercase() {
            match lower {
                '\u{00df}' => out.extend(['s', 's']),
                '\u{03c2}' => out.push('\u{03c3}'),
                other => out.push(other),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(text: &str, query: &str) -> Option<Hit> {
        Field::new(text).find(&Query::new(query))
    }

    fn tier(text: &str, query: &str) -> Tier {
        find(text, query)
            .unwrap_or_else(|| panic!("no match: {query:?} in {text:?}"))
            .tier
    }

    /// The matched pieces, read back out of the string that was never rewritten.
    fn highlighted<'a>(text: &'a str, hit: &Hit) -> Vec<&'a str> {
        hit.fragments
            .iter()
            .map(|part| &text[part.byte_start..part.byte_end])
            .collect()
    }

    fn parts<'a>(text: &'a str, query: &str) -> Vec<&'a str> {
        let hit = find(text, query).unwrap_or_else(|| panic!("no match: {query:?} in {text:?}"));
        highlighted(text, &hit)
    }

    #[test]
    fn chinese_matches_characters_in_order() {
        assert_eq!(tier("修复登录", "修登"), Tier::Subsequence);
        assert_eq!(parts("修复登录", "修登"), vec!["修", "登"]);
        assert_eq!(tier("修复登录", "修复登录"), Tier::Exact);
        assert_eq!(parts("修复登录", "修复登录"), vec!["修复登录"]);
    }

    #[test]
    fn english_matches_a_non_adjacent_abbreviation() {
        assert_eq!(tier("fix build graph", "fbg"), Tier::Subsequence);
        assert_eq!(parts("fix build graph", "fbg"), vec!["f", "b", "g"]);
        // One unbroken run is reported as one fragment, not as its letters.
        assert_eq!(tier("fix build graph", "build"), Tier::Contiguous);
        assert_eq!(parts("fix build graph", "build"), vec!["build"]);
        assert_eq!(tier("fix build graph", "fix"), Tier::Prefix);
        assert_eq!(tier("fix build graph", "fix build"), Tier::Prefix);
        assert_eq!(tier("fix build graph", "graph"), Tier::Contiguous);
    }

    #[test]
    fn mixed_scripts_do_not_borrow_from_each_other() {
        // The subject is Chinese, the query is Latin: nothing is shared, so
        // nothing matches — a hit across scripts would be a false claim.
        assert!(find("修复登录 graph", "fb").is_none());
        assert_eq!(tier("修复 login bug", "login"), Tier::Contiguous);
        assert_eq!(tier("修复 login bug", "lb"), Tier::Subsequence);
    }

    #[test]
    fn case_folds_without_being_asked_to() {
        assert_eq!(tier("Fix Build Graph", "fbg"), Tier::Subsequence);
        // The highlight still reads back the capitals that were actually there.
        assert_eq!(parts("Fix Build Graph", "fbg"), vec!["F", "B", "G"]);
        assert_eq!(tier("fix build graph", "FBG"), Tier::Subsequence);
        // İ lowercases to i plus a combining dot; the run still starts the field.
        assert_eq!(tier("İstanbul", "i"), Tier::Prefix);
    }

    #[test]
    fn one_code_point_matches_a_base_and_its_mark() {
        let composed = "L'\u{00e9}cole";
        let decomposed = "L'e\u{0301}cole";
        assert_ne!(composed, decomposed, "the fixture must be two encodings");
        assert_eq!(tier(composed, "école"), Tier::Contiguous);
        assert_eq!(tier(decomposed, "\u{00e9}cole"), Tier::Contiguous);
        assert_eq!(tier(composed, "\u{0065}\u{0301}cole"), Tier::Contiguous);
        // The highlight lands on the bytes of whichever encoding came in, and
        // the base with its mark is drawn as one piece.
        assert_eq!(parts(decomposed, "\u{00e9}cole"), vec!["e\u{0301}cole"]);
    }

    #[test]
    fn a_mark_is_not_stripped_from_either_side() {
        // Declared, not accidental: canonical equivalence is not base-letter
        // equivalence, so an unaccented query does not silently widen a search.
        assert!(find("école", "ecole").is_none());
        assert!(find("ecole", "école").is_none());
    }

    #[test]
    fn sharp_s_and_final_sigma_fold_where_lowercasing_stops() {
        assert_eq!(tier("Straße", "STRASSE"), Tier::Exact);
        assert_eq!(parts("Straße", "strasse"), vec!["Straße"]);
        assert_eq!(tier("ΙΣΟΧΟΥ", "ς"), Tier::Contiguous);
        assert_eq!(tier("γρήγορος", "ΓΡ"), Tier::Prefix);
    }

    #[test]
    fn an_emoji_cluster_matches_as_one_drawable_piece() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let text = format!("{family} fix the graph");
        assert_eq!(tier(&text, family), Tier::Prefix);
        assert_eq!(parts(&text, family), vec![family]);
        // Matching works per code point, so one member of the sequence is a
        // hit — and the fragment it reports is still the whole cluster, because
        // half a family emoji is not something a row can draw.
        assert_eq!(tier(&text, "\u{1F469}"), Tier::Contiguous);
        assert_eq!(parts(&text, "\u{1F469}"), vec![family]);
    }

    #[test]
    fn unit_offsets_index_the_utf16_string_a_row_is_drawn_from() {
        let text = "\u{1F525} x";
        let hit = find(text, "x").unwrap();
        let part = hit.fragments[0];
        assert_eq!(part.unit_start, 3, "fire is two units and the space is one");
        assert_eq!(
            part.byte_start, 5,
            "fire is four bytes and the space is one"
        );
        assert_eq!(part.unit_end, 4);
        assert_eq!(part.byte_end, 6);
    }

    #[test]
    fn an_empty_or_too_long_query_is_not_a_result() {
        assert!(Query::new("").is_empty());
        assert!(!Query::new("   ").is_empty(), "spaces are characters");
        assert!(find("anything", "").is_none());
        assert!(find("ab", "abc").is_none());
        assert!(find("", "a").is_none());
    }

    #[test]
    fn the_same_input_folds_to_the_same_hit_every_time() {
        for _ in 0..8 {
            let hit = find("修复登录 path", "修登").unwrap();
            assert_eq!(hit.tier, Tier::Subsequence);
            assert_eq!(hit.rank(), (3, 3, 3), "tier, clusters, folded code points");
        }
    }

    #[test]
    fn a_tighter_window_ranks_above_a_wider_one_at_the_same_tier() {
        let near = find("fix crash", "fc").unwrap();
        let far = find("fix a crash", "fc").unwrap();
        assert_eq!(near.tier, Tier::Subsequence);
        assert_eq!(far.tier, Tier::Subsequence);
        assert_eq!((near.rank(), far.rank()), ((3, 5, 5), (3, 7, 7)));
        assert!(
            near.rank() < far.rank(),
            "{:?} should beat {:?}",
            near.rank(),
            far.rank()
        );
    }

    #[test]
    fn equal_ranks_keep_the_order_the_candidates_arrived_in() {
        let query = Query::new("fix");
        let candidates = ["a fix", "fix", "the fix"];
        let mut ranked = candidates
            .iter()
            .enumerate()
            .map(|(index, text)| (index, Field::new(text).find(&query).unwrap().rank()))
            .collect::<Vec<_>>();
        ranked.sort_by_key(|entry| entry.1);
        let order = ranked.iter().map(|entry| entry.0).collect::<Vec<_>>();
        assert_eq!(order, vec![1, 0, 2], "the exact field wins, then the tie");
        assert_eq!(
            ranked[1].1, ranked[2].1,
            "the two that tie have the same key"
        );
    }

    /// What a scan of one page of history costs, because the whole search
    /// budget is this loop times the number of subjects a batch reads. The
    /// ceiling is deliberately loose: it catches an order-of-magnitude
    /// regression, not a noisy neighbour. The measured figure is recorded with
    /// the stage, and `--nocapture` prints it.
    #[test]
    fn a_batch_of_subject_lines_folds_inside_a_loose_budget() {
        let subjects: Vec<String> = (0..10_000)
            .map(|index| {
                if index % 4 == 0 {
                    format!("修复登录 bug {index}")
                } else {
                    format!("fix build graph {index}")
                }
            })
            .collect();
        let started = std::time::Instant::now();
        let query = Query::new("fbg");
        let mut hits = 0;
        for subject in &subjects {
            if Field::new(subject).find(&query).is_some() {
                hits += 1;
            }
        }
        let elapsed = started.elapsed();
        println!(
            "10,000 subject lines built, folded and scanned in {} ms",
            elapsed.as_millis()
        );
        assert_eq!(
            hits, 7_500,
            "the Chinese lines share no character with the query"
        );
        assert!(
            elapsed.as_millis() < 2_000,
            "one scan of ten thousand lines took {elapsed:?}"
        );
    }
}
