use gix::{bstr::BString, objs::tree::EntryMode};

/// A file as a revision has it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileVersion {
    pub mode: EntryMode,
    pub data: BString,
}
