use std::path::PathBuf;

use cabaret_lib::{Cabaret, ChangeId, Result, WorkspaceId};
use clap::{Subcommand, ValueHint};

use crate::args::change_completer;

#[derive(Subcommand)]
pub enum WorkspaceCommand {
    /// Create a workspace with a change checked out, beside the main one unless told where.
    Add {
        #[arg(add = change_completer())]
        change: ChangeId,
        #[arg(long, value_hint = ValueHint::DirPath)]
        path: Option<PathBuf>,
    },
    /// Swap the change held in this workspace.
    Switch {
        #[arg(add = change_completer())]
        switch_to: ChangeId,
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(long, value_hint = ValueHint::DirPath, conflicts_with = "change")]
        path: Option<PathBuf>,
    },
    List,
    /// Find the path of the workspace holding a change.
    Path {
        #[arg(add = change_completer())]
        change: ChangeId,
    },
    /// Remove every workspace whose change is archived.
    Prune,
    /// Remove the workspace holding a change, or the one at a path.
    Remove {
        #[arg(add = change_completer(), required_unless_present = "path")]
        change: Option<ChangeId>,
        #[arg(long, value_hint = ValueHint::DirPath, conflicts_with = "change")]
        path: Option<PathBuf>,
    },
}

impl WorkspaceCommand {
    pub fn run(self, cabaret: Cabaret) -> Result<()> {
        match self {
            WorkspaceCommand::Add { change, path } => {
                let path = cabaret.workspace_add(change, path)?;
                println!("{}", path.display());
            }
            WorkspaceCommand::Switch { switch_to, change, path } => {
                let workspace = match named(&cabaret, change, path)? {
                    Some(workspace) => workspace,
                    None => cabaret.workspace_current()?,
                };
                cabaret.workspace_switch(workspace.to_ref(), switch_to)?;
            }
            WorkspaceCommand::List => {
                for (workspace, change) in cabaret.workspaces()? {
                    match change {
                        Some(change) => println!("{workspace}\t{change}"),
                        None => println!("{workspace}\t(detached)"),
                    }
                }
            }
            WorkspaceCommand::Path { change } => {
                let workspace = holding(&cabaret, &change)?;
                println!("{}", cabaret.workspace_path(workspace.to_ref())?.display());
            }
            WorkspaceCommand::Prune => {
                let prune = cabaret.workspace_prune()?;
                for workspace in &prune.removed {
                    println!("removed {workspace}");
                }
                for (workspace, reason) in &prune.kept {
                    println!("kept {workspace}: {reason}");
                }
            }
            WorkspaceCommand::Remove { change, path } => {
                let workspace = named(&cabaret, change, path)?.expect("clap requires one of change or path");
                cabaret.workspace_remove(workspace.to_ref())?;
            }
        }

        Ok(())
    }
}

/// The workspace a command names by change or by path; clap keeps the two exclusive.
fn named(cabaret: &Cabaret, change: Option<ChangeId>, path: Option<PathBuf>) -> Result<Option<WorkspaceId>> {
    Ok(match (change, path) {
        (Some(change), _) => Some(holding(cabaret, &change)?),
        (None, Some(path)) => Some(cabaret.workspace_at(&path)?),
        (None, None) => None,
    })
}

fn holding(cabaret: &Cabaret, change: &ChangeId) -> Result<WorkspaceId> {
    cabaret.workspace_holding(change)?.ok_or_else(|| format!("{change} is not checked out in any workspace").into())
}
