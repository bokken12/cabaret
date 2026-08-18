use cabaret_lib::{cabaret::Cabaret, error::Result, types::ChangeId};
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
    pub fn run(self, cabaret: Cabaret) -> Result<()> {
        match self {
            WorkspaceCommand::Add { change } => {
                let path = cabaret.add_workspace(&change)?;
                println!("added workspace {change} at {}", path.display());
            }
            WorkspaceCommand::Remove { change } => {
                let path = cabaret.remove_workspace(&change)?;
                println!("removed workspace {change} at {}", path.display());
            }
            WorkspaceCommand::List => {
                for (change, path) in cabaret.workspaces()? {
                    println!("{change} {}", path.display());
                }
            }
        };

        Ok(())
    }
}
