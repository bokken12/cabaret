use cabaret_lib::{cabaret::CabaretOld, change::ChangeId, error::Result};
use clap::Subcommand;

use crate::completion::change_completer;

#[derive(Subcommand)]
pub enum WorkspaceCommand {
    Add {
        #[arg(add = change_completer())]
        change: ChangeId,
    },
    Remove {
        #[arg(add = change_completer())]
        change: ChangeId,
    },
    List,
}

impl WorkspaceCommand {
    pub fn run(self, cabaret: CabaretOld) -> Result<()> {
        match self {
            WorkspaceCommand::Add { change } => {
                let path = cabaret.add_workspace(&change)?;
                println!("added workspace {change} at {}", path.display());
            }
            WorkspaceCommand::Remove { change: _ } => {
                todo!()
            }
            WorkspaceCommand::List => {
                for workspace in cabaret.workspaces()? {
                    println!("{workspace}");
                }
            }
        };

        Ok(())
    }
}
