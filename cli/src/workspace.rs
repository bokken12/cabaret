use cabaret_lib::{cabaret::Cabaret, change::ChangeId, error::Result};
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
                todo!()
            }
            WorkspaceCommand::Remove { change: _ } => {
                todo!()
            }
            WorkspaceCommand::List => {
                todo!()
            }
        };

        Ok(())
    }
}
