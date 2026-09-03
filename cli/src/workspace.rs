use cabaret_lib::{cabaret::Cabaret, error::Result, types::ChangeId};
use clap::Subcommand;

use crate::args::change_completer;

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
                for (workspace, change) in cabaret.workspaces()? {
                    match change {
                        Some(change) => println!("{workspace}\t{change}"),
                        None => println!("{workspace}\t(detached)"),
                    }
                }
            }
        };

        Ok(())
    }
}
