use gix::{ObjectId, bstr::BStr, objs::tree::EntryMode};

use crate::{
    base::Base,
    cabaret::Cabaret,
    error::Result,
    types::{ChangeId, Pathspec},
};

/// A change's diff: every file that differs between its base and its tip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
    pub base: Base,
    /// Sorted by path.
    pub files: Vec<ChangedFile>,
}

/// One file that differs between a change's base and its tip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangedFile {
    Added { path: String, tip: FileVersion },
    Deleted { path: String, base: FileVersion },
    Modified { path: String, base: FileVersion, tip: FileVersion },
    Moved { from: String, path: String, copied: bool, base: FileVersion, tip: FileVersion },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileVersion {
    pub id: ObjectId,
    pub mode: EntryMode,
}

impl ChangedFile {
    /// The path at the tip, or at the base for deletions.
    pub fn path(&self) -> &str {
        match self {
            Self::Added { path, .. }
            | Self::Deleted { path, .. }
            | Self::Modified { path, .. }
            | Self::Moved { path, .. } => path,
        }
    }

    /// The file at the base; absent when it was added.
    pub fn base(&self) -> Option<&FileVersion> {
        match self {
            Self::Added { .. } => None,
            Self::Deleted { base, .. } | Self::Modified { base, .. } | Self::Moved { base, .. } => Some(base),
        }
    }

    /// The file at the tip; absent when it was deleted.
    pub fn tip(&self) -> Option<&FileVersion> {
        match self {
            Self::Deleted { .. } => None,
            Self::Added { tip, .. } | Self::Modified { tip, .. } | Self::Moved { tip, .. } => Some(tip),
        }
    }
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
        files.sort_by(|a, b| a.path().cmp(b.path()));
        Ok(Diff { base, files })
    }

    /// The subset of `files` matching `pathspecs`, or all of them when none are given.
    /// A moved or copied file also answers to its source path.
    pub fn select(&self, files: Vec<ChangedFile>, pathspecs: Vec<Pathspec>) -> Result<Vec<ChangedFile>> {
        if pathspecs.is_empty() {
            return Ok(files);
        }
        let root = self.repo.workdir().unwrap_or_else(|| self.repo.git_dir()).to_owned();
        let mut search =
            gix::pathspec::Search::from_specs(pathspecs.into_iter().map(|spec| spec.0), self.repo.prefix()?, &root)?;
        let mut matches = |path: &str| {
            search
                .pattern_matching_relative_path(BStr::new(path), Some(false), &mut |_, _, _, _| false)
                .is_some_and(|m| !m.is_excluded())
        };
        Ok(files
            .into_iter()
            .filter(|file| matches(&file.path) || file.source.as_ref().is_some_and(|source| matches(&source.path)))
            .collect())
    }
}

fn changed_file(change: gix::diff::tree_with_rewrites::Change) -> Option<ChangedFile> {
    use gix::diff::tree_with_rewrites::Change;
    let file = |id, mode| FileVersion { id, mode };
    match change {
        Change::Addition { location, entry_mode, id, .. } if !entry_mode.is_tree() => {
            Some(ChangedFile::Added { path: location.to_string(), tip: file(id, entry_mode) })
        }
        Change::Deletion { location, entry_mode, id, .. } if !entry_mode.is_tree() => {
            Some(ChangedFile::Deleted { path: location.to_string(), base: file(id, entry_mode) })
        }
        Change::Modification { location, previous_entry_mode, previous_id, entry_mode, id }
            if !entry_mode.is_tree() =>
        {
            Some(ChangedFile::Modified {
                path: location.to_string(),
                base: file(previous_id, previous_entry_mode),
                tip: file(id, entry_mode),
            })
        }
        Change::Rewrite { source_location, source_entry_mode, source_id, entry_mode, id, location, copy, .. }
            if !entry_mode.is_tree() =>
        {
            Some(ChangedFile::Moved {
                from: source_location.to_string(),
                path: location.to_string(),
                copied: copy,
                base: file(source_id, source_entry_mode),
                tip: file(id, entry_mode),
            })
        }
        _ => None,
    }
}
