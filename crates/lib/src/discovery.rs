use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use crate::{Cabaret, Result, WorkspaceIdRef};

/// Find the checkout containing `dir`, or repositories immediately below a container directory.
/// Sibling worktrees are one repository, identified by the canonical common Git directory.
/// This never recursively scans the container and never initializes a repository.
pub fn discover_repositories(dir: &Path) -> Result<Vec<PathBuf>> {
    if let Ok(repository) = Cabaret::open(dir) {
        let workspace = repository
            .workspace_current()
            .and_then(|id| repository.workspace_path(id.to_ref()))
            .unwrap_or_else(|_| dir.to_owned());
        return Ok(vec![fs::canonicalize(workspace)?]);
    }
    // A broken checkout should retain its original error, not become a container.
    if dir.join(".git").exists() {
        Cabaret::open(dir)?;
    }
    let mut repositories = BTreeMap::new();
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_dir() || !path.join(".git").exists() {
            continue;
        }
        // Resolve each candidate as a unit: a broken child must not hide healthy siblings.
        let Ok((common, workspace)) = resolve_candidate(&path) else { continue };
        repositories.entry(common).or_insert(workspace);
    }
    Ok(repositories.into_values().collect())
}

fn resolve_candidate(path: &Path) -> Result<(PathBuf, PathBuf)> {
    let repository = Cabaret::open(path)?;
    let common = fs::canonicalize(repository.common_dir())?;
    // Prefer main, but a linked checkout can still be usable if main's path is stale.
    let workspace = repository.workspace_path(WorkspaceIdRef::Main)
        .and_then(|path| Ok(fs::canonicalize(path)?))
        .or_else(|_| -> Result<PathBuf> {
            let current = repository.workspace_current()?;
            Ok(fs::canonicalize(repository.workspace_path(current.to_ref())?)?)
        })?;
    Ok((common, workspace))
}
