use std::path::Path;

/// Compares two filesystem paths through canonicalization. Returns `None`
/// when either side cannot be resolved, so callers can distinguish "same",
/// "different" and "unknown" instead of guessing.
pub fn same_path(a: &Path, b: &Path) -> Option<bool> {
    let (Ok(a), Ok(b)) = (a.canonicalize(), b.canonicalize()) else {
        return None;
    };
    #[cfg(windows)]
    return Some(a.eq_ignore_ascii_case(&b));
    #[cfg(not(windows))]
    return Some(a == b);
}
