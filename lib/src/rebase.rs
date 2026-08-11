use std::{collections::BTreeSet, fs, path::Path};

use gix::{
    ObjectId,
    bstr::{BStr, BString, ByteSlice},
    merge::blob::builtin_driver::text::{Conflict, ConflictStyle, Labels},
    object::tree::diff::ChangeDetached,
    objs::tree::EntryKind,
};

use crate::{cabaret::Cabaret, error::Result, types::ChangeId};

#[derive(Debug, PartialEq, Eq)]
pub enum Rebase {
    UpToDate,
    Merged { conflicts: Vec<String> },
}

fn branch_ref(change: &ChangeId) -> String { format!("refs/heads/{change}") }

impl Cabaret {
    /// Merge the parent's tip into `change`. Conflicts are committed immediately with
    /// conflict markers in the affected files, never left as an in-progress merge.
    pub fn rebase(&self, change: &ChangeId, onto: Option<&ChangeId>) -> Result<Rebase> {
        let parents = self.change(change)?.parents;
        let parent = choose_parent(change, &parents, onto)?;

        let change_tip = self.tip(change)?;
        let parent_tip = self.tip(parent)?;
        if self.repo.merge_base(change_tip, parent_tip)? == parent_tip {
            return Ok(Rebase::UpToDate);
        }

        let checked_out =
            self.repo.head_name()?.is_some_and(|head| head.as_bstr() == branch_ref(change).as_bytes().as_bstr());
        let worktree = if checked_out { self.repo.workdir().map(Path::to_owned) } else { None };
        if worktree.is_some() && self.repo.is_dirty()? {
            return Err("working tree has uncommitted changes".into());
        }

        // Conflict style and labels are forced rather than read from config so the committed
        // conflict text is identical no matter whose clone performs the rebase.
        let labels = Labels {
            ancestor: Some("base".into()),
            current: Some(change.0.as_str().into()),
            other: Some(parent.0.as_str().into()),
        };
        let mut options: gix::merge::plumbing::tree::Options = self.repo.tree_merge_options()?.into();
        options.blob_merge.text.conflict = Conflict::Keep {
            style: ConflictStyle::ZealousDiff3,
            marker_size: Conflict::DEFAULT_MARKER_SIZE.try_into().expect("marker size is non-zero"),
        };
        let options = gix::merge::tree::Options::from(options);
        let mut merge = self.repo.merge_commits(change_tip, parent_tip, labels, options.into())?;
        let merged_tree = merge.tree_merge.tree.write()?.detach();
        let unresolved = gix::merge::tree::TreatAsUnresolved::default();
        let mut conflicts: Vec<String> = merge
            .tree_merge
            .conflicts
            .iter()
            .filter(|conflict| conflict.is_unresolved(unresolved))
            .map(|conflict| conflict.changes_in_resolution().0.location().to_string())
            .collect();
        conflicts.sort();
        conflicts.dedup();

        let edits = match &worktree {
            Some(workdir) => {
                let old_tree = self.repo.find_commit(change_tip)?.tree()?;
                let new_tree = self.repo.find_tree(merged_tree)?;
                let edits = WorktreeEdits::plan(self.repo.diff_tree_to_tree(
                    &old_tree,
                    &new_tree,
                    gix::diff::Options::default(),
                )?)?;
                edits.validate(workdir)?;
                Some(edits)
            }
            None => None,
        };

        self.repo.commit(
            branch_ref(change).as_str(),
            format!("rebase onto {parent}"),
            merged_tree,
            [change_tip, parent_tip],
        )?;

        if let Some((edits, workdir)) = edits.zip(worktree) {
            edits.apply(self, &workdir)?;
        }
        Ok(Rebase::Merged { conflicts })
    }

    fn tip(&self, change: &ChangeId) -> Result<ObjectId> {
        Ok(self.repo.find_reference(&branch_ref(change))?.peel_to_commit()?.id)
    }
}

fn choose_parent<'a>(
    change: &ChangeId,
    parents: &'a BTreeSet<ChangeId>,
    onto: Option<&'a ChangeId>,
) -> Result<&'a ChangeId> {
    match onto {
        Some(parent) => {
            if !parents.contains(parent) {
                return Err(format!("{parent} is not a parent of {change}").into());
            }
            Ok(parent)
        }
        None => match parents.len() {
            0 => Err(format!("{change} has no parents").into()),
            1 => Ok(parents.first().expect("len is 1")),
            _ => {
                let parents: Vec<String> = parents.iter().map(ToString::to_string).collect();
                Err(format!("{change} has multiple parents; pass the one to rebase onto: {}", parents.join(", "))
                    .into())
            }
        },
    }
}

struct Write {
    path: BString,
    kind: EntryKind,
    id: ObjectId,
    is_new: bool,
}

/// The worktree and index updates a tree transition requires, planned up front so collisions
/// with untracked files are detected before any ref moves or files change.
struct WorktreeEdits {
    deletions: Vec<BString>,
    writes: Vec<Write>,
}

impl WorktreeEdits {
    fn plan(changes: Vec<ChangeDetached>) -> Result<Self> {
        let mut deletions = Vec::new();
        let mut writes = Vec::new();
        for change in changes {
            match change {
                ChangeDetached::Addition { location, entry_mode, id, .. } => {
                    if let Some(kind) = file_kind(entry_mode.kind())? {
                        writes.push(Write { path: location, kind, id, is_new: true });
                    }
                }
                ChangeDetached::Deletion { location, entry_mode, .. } => {
                    if file_kind(entry_mode.kind())?.is_some() {
                        deletions.push(location);
                    }
                }
                ChangeDetached::Modification { location, entry_mode, id, .. } => {
                    if let Some(kind) = file_kind(entry_mode.kind())? {
                        writes.push(Write { path: location, kind, id, is_new: false });
                    }
                }
                ChangeDetached::Rewrite { .. } => unreachable!("rewrite tracking is disabled"),
            }
        }
        Ok(Self { deletions, writes })
    }

    fn validate(&self, workdir: &Path) -> Result<()> {
        for write in &self.writes {
            if write.is_new {
                let path = workdir.join(gix::path::from_bstr(write.path.as_bstr()));
                if path.symlink_metadata().is_ok_and(|meta| !meta.is_dir()) {
                    return Err(format!("untracked file {} is in the way", write.path).into());
                }
            }
        }
        Ok(())
    }

    fn apply(&self, cabaret: &Cabaret, workdir: &Path) -> Result<()> {
        let mut index = cabaret.repo.open_index()?;
        let deleted: BTreeSet<&BStr> = self.deletions.iter().map(|path| path.as_bstr()).collect();
        index.remove_entries(|_, path, _| deleted.contains(path));
        for path in &self.deletions {
            let path = workdir.join(gix::path::from_bstr(path.as_bstr()));
            fs::remove_file(&path)?;
            prune_empty_dirs(workdir, path.parent().expect("worktree files have a parent"));
        }
        for write in &self.writes {
            let path = workdir.join(gix::path::from_bstr(write.path.as_bstr()));
            write_file(cabaret, &path, write)?;
            let stat = gix::index::entry::Stat::from_fs(&gix::index::fs::Metadata::from_path_no_follow(&path)?)?;
            let mode = index_mode(write.kind);
            if write.is_new {
                index.dangerously_push_entry(
                    stat,
                    write.id,
                    gix::index::entry::Flags::empty(),
                    mode,
                    write.path.as_bstr(),
                );
            } else {
                let entry = index
                    .entry_mut_by_path_and_stage(write.path.as_bstr(), gix::index::entry::Stage::Unconflicted)
                    .ok_or_else(|| format!("{} is missing from the index", write.path))?;
                entry.stat = stat;
                entry.id = write.id;
                entry.mode = mode;
            }
        }
        index.sort_entries();
        index.remove_tree();
        index.write(gix::index::write::Options::default())?;
        Ok(())
    }
}

/// `None` for trees, which the diff also reports but which need no worktree edit of their own.
fn file_kind(kind: EntryKind) -> Result<Option<EntryKind>> {
    match kind {
        EntryKind::Tree => Ok(None),
        EntryKind::Blob | EntryKind::BlobExecutable | EntryKind::Link => Ok(Some(kind)),
        EntryKind::Commit => Err("submodules are not supported".into()),
    }
}

fn index_mode(kind: EntryKind) -> gix::index::entry::Mode {
    match kind {
        EntryKind::Blob => gix::index::entry::Mode::FILE,
        EntryKind::BlobExecutable => gix::index::entry::Mode::FILE_EXECUTABLE,
        EntryKind::Link => gix::index::entry::Mode::SYMLINK,
        EntryKind::Tree | EntryKind::Commit => unreachable!("filtered out by file_kind"),
    }
}

// TODO-someday(jm): apply checkout filters (.gitattributes, eol) when writing blobs.
fn write_file(cabaret: &Cabaret, path: &Path, write: &Write) -> Result<()> {
    let blob = cabaret.repo.find_object(write.id)?.try_into_blob()?;
    match path.symlink_metadata() {
        Ok(_) => fs::remove_file(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path.parent().expect("worktree files have a parent"))?;
        }
        Err(error) => return Err(error.into()),
    }
    match write.kind {
        EntryKind::Blob | EntryKind::BlobExecutable => {
            use std::os::unix::fs::OpenOptionsExt as _;
            let mode = if write.kind == EntryKind::BlobExecutable { 0o777 } else { 0o666 };
            let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(path)?;
            std::io::Write::write_all(&mut file, &blob.data)?;
        }
        EntryKind::Link => {
            let target = gix::path::from_bstr(blob.data.as_bstr());
            std::os::unix::fs::symlink(target, path)?;
        }
        EntryKind::Tree | EntryKind::Commit => unreachable!("filtered out by file_kind"),
    }
    Ok(())
}

fn prune_empty_dirs(workdir: &Path, mut dir: &Path) {
    while dir != workdir && fs::remove_dir(dir).is_ok() {
        dir = dir.parent().expect("pruning stops at the worktree root");
    }
}
