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
        change: ChangeId,
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
            WorkspaceCommand::Switch { change } => {
                todo!()
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
                todo!()
            }
        }

        Ok(())
    }
}

fn holding(cabaret: &Cabaret, change: &ChangeId) -> Result<WorkspaceId> {
    cabaret.snapshot(change)?.workspace.ok_or_else(|| format!("{change} is not checked out in any workspace").into())
}
