use std::path::PathBuf;

use cabaret_lib::{
    cabaret::Cabaret,
    error::Result,
    types::{ChangeId, WorkspaceId},
};
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
                todo!()
            }
            WorkspaceCommand::Switch { switch_to, change, path } => {
                let workspace_id = match (change, path) {
                    (Some(_), Some(_)) => Err("must pass exactly one of change or path")?,
                    (None, None) => cabaret.workspace_current(),
                    (None, Some(path)) => WorkspaceId::of_path(&path),
                    (Some(change_id), None) => cabaret
                        .workspace_holding(&change_id)?
                        .ok_or_else(|| format!("{change_id} is not currently held by a workspace"))?,
                };
                cabaret.workspace_switch(workspace_id.to_ref(), switch_to)?
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
                todo!()
            }
            WorkspaceCommand::Remove { change, path } => {
                let workspace_id = match (change, path) {
                    (None, None) | (Some(_), Some(_)) => Err("must pass exactly one of change or path")?,
                    (None, Some(path)) => WorkspaceId::of_path(&path),
                    (Some(change_id), None) => cabaret
                        .workspace_holding(&change_id)?
                        .ok_or_else(|| format!("{change_id} is not currently held by a workspace"))?,
                };
                cabaret.workspace_remove(workspace_id.to_ref())?
            }
        }

        Ok(())
    }
}

fn holding(cabaret: &Cabaret, change: &ChangeId) -> Result<WorkspaceId> {
    cabaret.snapshot(change)?.workspace.ok_or_else(|| format!("{change} is not checked out in any workspace").into())
}
