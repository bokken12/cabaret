use gix::diff::blob::{Algorithm, Diff, InternedInput, diff_with_slider_heuristics};

use crate::file_version::FileVersion;

/// The lines a file's diff adds and removes, counted as its unified diff shows them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineCounts {
    Binary,
    Text { added: u32, removed: u32 },
}

impl LineCounts {
    /// Between the sides a file is on: a missing side counts as empty.
    pub fn new(before: Option<&FileVersion>, after: Option<&FileVersion>) -> Self {
        let old = before.map(|version| version.data.as_slice()).unwrap_or_default();
        let new = after.map(|version| version.data.as_slice()).unwrap_or_default();
        if is_binary(old) || is_binary(new) {
            return Self::Binary;
        }
        let diff = line_diff(&InternedInput::new(old, new));
        Self::Text { added: diff.count_additions(), removed: diff.count_removals() }
    }
}

/// As git decides, by a NUL byte early on.
pub fn is_binary(data: &[u8]) -> bool { data[..data.len().min(8000)].contains(&0) }

/// With fixed options, so that every clone diffs alike.
pub fn line_diff(input: &InternedInput<&[u8]>) -> Diff { diff_with_slider_heuristics(Algorithm::Histogram, input) }
