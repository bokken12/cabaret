use gix::{ObjectId, objs::tree::EntryMode};

use crate::{base::Base, cabaret::Cabaret, error::Result, types::ChangeId};

/// A change's diff: every file that differs between its base and its tip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
    pub base: Base,
    /// Sorted by path.
    pub files: Vec<ChangedFile>,
}

/// One file that differs between a change's base and its tip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    /// The path at the tip, or at the base for deletions.
    pub path: String,
    /// Where the file came from, when it was moved or copied.
    pub source: Option<Source>,
    /// The file at the base; absent when the file was added.
    pub base: Option<FileVersion>,
    /// The file at the tip; absent when the file was deleted.
    pub tip: Option<FileVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub path: String,
    pub copied: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileVersion {
    pub id: ObjectId,
    pub mode: EntryMode,
}

impl Cabaret {
    /// The diff of `change`: the files that differ between its base and its tip.
    pub fn diff(&self, change: &ChangeId) -> Result<Diff> {
        let base = self.base(change)?;
        let base_tree = match &base {
            Base::Empty => self.repo.empty_tree(),
            Base::Real(revision) | Base::Synthetic { revision, .. } => self.repo.find_commit(revision.0)?.tree()?,
        };
        let tip_tree = self.repo.find_commit(self.tip(change)?)?.tree()?;
        // Rename detection is forced for the same reason merges force it: the same revisions
        // must describe the same diff in every clone.
        let options = gix::diff::Options::default().with_rewrites(Some(gix::diff::Rewrites::default()));
        let mut files: Vec<ChangedFile> =
            self.repo.diff_tree_to_tree(&base_tree, &tip_tree, options)?.into_iter().filter_map(changed_file).collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Diff { base, files })
    }
}

fn changed_file(change: gix::diff::tree_with_rewrites::Change) -> Option<ChangedFile> {
    use gix::diff::tree_with_rewrites::Change;
    let file = |id, mode| Some(FileVersion { id, mode });
    match change {
        Change::Addition { location, entry_mode, id, .. } if !entry_mode.is_tree() => {
            Some(ChangedFile { path: location.to_string(), source: None, base: None, tip: file(id, entry_mode) })
        }
        Change::Deletion { location, entry_mode, id, .. } if !entry_mode.is_tree() => {
            Some(ChangedFile { path: location.to_string(), source: None, base: file(id, entry_mode), tip: None })
        }
        Change::Modification { location, previous_entry_mode, previous_id, entry_mode, id }
            if !entry_mode.is_tree() =>
        {
            Some(ChangedFile {
                path: location.to_string(),
                source: None,
                base: file(previous_id, previous_entry_mode),
                tip: file(id, entry_mode),
            })
        }
        Change::Rewrite { source_location, source_entry_mode, source_id, entry_mode, id, location, copy, .. }
            if !entry_mode.is_tree() =>
        {
            Some(ChangedFile {
                path: location.to_string(),
                source: Some(Source { path: source_location.to_string(), copied: copy }),
                base: file(source_id, source_entry_mode),
                tip: file(id, entry_mode),
            })
        }
        _ => None,
    }
}
