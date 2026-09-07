use cabaret_types::{ChangedFile, Pathspec, Result, TreeId};
use gix::{Repository, Tree as GixTree};

// TODO(joel): internal name?
pub struct Tree<'ctx>(GixTree<'ctx>);

impl<'ctx> Tree<'ctx> {
    pub fn id(&self) -> TreeId { TreeId(self.0.id) }
}

/// The file-level changes from `from`, nothing for a root, to `to`, with renames detected and
/// restricted to those matching `pathspecs` on either side (all when empty), in path order.
pub(crate) fn changed_files(
    repo: &Repository,
    from: Option<&GixTree<'_>>,
    to: &GixTree<'_>,
    pathspecs: &[Pathspec],
) -> Result<Vec<ChangedFile>> {
    let mut search = gix::Pathspec::new(repo, false, pathspecs.iter().map(|spec| spec.0.to_bstring()), false, || {
        Err("attribute pathspecs are not supported".into())
    })?;
    let mut files = repo
        .diff_tree_to_tree(from, Some(to), None)?
        .into_iter()
        // rewrite tracking reports moved directories alongside the files within them
        .filter(|change| !change.entry_mode().is_tree())
        .map(ChangedFile::try_from)
        .collect::<Result<Vec<_>>>()?;
    files.retain(|file| file.paths().any(|path| search.is_included(path.as_bstr(), Some(false))));
    files.sort_by(|a, b| a.paths().last().cmp(&b.paths().last()));
    Ok(files)
}
