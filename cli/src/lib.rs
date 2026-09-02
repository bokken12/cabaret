use cabaret_lib::{
    cabaret::Cabaret,
    error::Result,
    types::{Identity, Pathspec},
};
use clap::{Parser, Subcommand, ValueHint};

pub mod change;
pub mod completion;
pub mod workspace;

use crate::{change::ChangeCommand, workspace::WorkspaceCommand};

#[derive(Subcommand)]
enum Command {
    Change {
        #[command(subcommand)]
        command: ChangeCommand,
    },
    Commit {
        #[arg(value_hint = ValueHint::AnyPath)]
        pathspecs: Vec<Pathspec>,
    },
    Config,
    Fetch,
    /// Show your open changes as a stack graph.
    Home {
        /// Identity to view as; defaults to git's user.email.
        #[arg(long = "as")]
        viewer: Option<Identity>,
    },
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
}

#[derive(Parser)]
#[command(name = "cab", version, about = "Cabaret Code Review")]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

pub fn run() -> Result<()> {
    let cli = Cli::parse();
    let cabaret = Cabaret::open(std::env::current_dir()?)?;

    match cli.command {
        Command::Change { command } => command.run(cabaret)?,
        Command::Commit { .. } => todo!(),
        Command::Config => todo!(),
        Command::Fetch => fetch(&cabaret)?,
        Command::Home { viewer } => {
            let viewer = match viewer {
                Some(viewer) => viewer,
                None => cabaret.identity()?,
            };
            print!("{}", cabaret.home_page(&viewer)?);
        }
        Command::Workspace { command } => command.run(cabaret)?,
    }

    Ok(())
}

fn fetch(cabaret: &Cabaret) -> Result<()> { todo!() }
