//! Diffs as `git diff` shows them, so that people, agents and git tools alike can read them.

use cabaret_lib::{
    ChangedFile, FileVersion,
    gix::{
        bstr::{BString, ByteVec},
        diff::blob::{
            InternedInput, UnifiedDiff,
            unified_diff::{ConsumeHunk, ContextSize, DiffLineKind, HunkHeader},
        },
    },
    is_binary, line_diff,
};

/// `file`'s diff from `before` to `after`, with fixed options so that every clone renders it alike.
pub fn unified(file: &ChangedFile, before: Option<&FileVersion>, after: Option<&FileVersion>) -> BString {
    let (from, path) = (file.source(), file.path());
    let mut diff = BString::from(format!("diff --git a/{from} b/{path}\n"));
    match (before, after) {
        (None, Some(after)) => diff.push_str(format!("new file mode {:o}\n", after.mode)),
        (Some(before), None) => diff.push_str(format!("deleted file mode {:o}\n", before.mode)),
        (Some(before), Some(after)) if before.mode != after.mode => {
            diff.push_str(format!("old mode {:o}\nnew mode {:o}\n", before.mode, after.mode));
        }
        _ => {}
    }
    match file {
        ChangedFile::Renamed { .. } => diff.push_str(format!("rename from {from}\nrename to {path}\n")),
        ChangedFile::Copied { .. } => diff.push_str(format!("copy from {from}\ncopy to {path}\n")),
        ChangedFile::Added { .. } | ChangedFile::Deleted { .. } | ChangedFile::Modified { .. } => {}
    }

    let a = before.map_or_else(|| "/dev/null".to_owned(), |_| format!("a/{from}"));
    let b = after.map_or_else(|| "/dev/null".to_owned(), |_| format!("b/{path}"));
    let empty = BString::default();
    let old = before.map_or(&empty, |before| &before.data);
    let new = after.map_or(&empty, |after| &after.data);
    if old == new {
        return diff;
    }
    if is_binary(old) || is_binary(new) {
        diff.push_str(format!("Binary files {a} and {b} differ\n"));
        return diff;
    }
    diff.push_str(format!("--- {a}\n+++ {b}\n"));
    let input = InternedInput::new(old.as_slice(), new.as_slice());
    let lines = line_diff(&input);
    let hunks = UnifiedDiff::new(&lines, &input, Hunks::default(), ContextSize::symmetrical(3));
    diff.extend_from_slice(&hunks.consume().expect("rendering hunks to memory cannot fail"));
    diff
}

/// Hunks as unified diff text, marking lines that end without a newline as git does.
#[derive(Default)]
struct Hunks(BString);

impl ConsumeHunk for Hunks {
    type Out = BString;

    fn consume_hunk(&mut self, header: HunkHeader, lines: &[(DiffLineKind, &[u8])]) -> std::io::Result<()> {
        self.0.push_str(format!("{header}\n"));
        for &(kind, line) in lines {
            self.0.push_char(kind.to_prefix());
            self.0.extend_from_slice(line);
            if !line.ends_with(b"\n") {
                self.0.push_str("\n\\ No newline at end of file\n");
            }
        }
        Ok(())
    }

    fn finish(self) -> BString { self.0 }
}
