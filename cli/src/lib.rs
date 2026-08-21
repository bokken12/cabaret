use cabaret_lib::{
    cabaret2::Cabaret,
    error::Result,
    sync::SyncOutcome,
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
    Home {
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
            todo!()
        }
        Command::Workspace { command } => command.run(cabaret)?,
    }

    Ok(())
}

fn fetch(cabaret: &Cabaret) -> Result<()> {
    cabaret.fetch()?;
    let mut ahead = Vec::new();
    for change in cabaret.branches()? {
        match cabaret.sync_branch(&change)? {
            SyncOutcome::Unpublished | SyncOutcome::UpToDate => {}
            SyncOutcome::FastForwarded => println!("fast-forwarded {change}"),
            SyncOutcome::Dirty => println!("skipped {change}: uncommitted changes"),
            SyncOutcome::Diverged => println!("skipped {change}: diverged from remote"),
            SyncOutcome::Ahead => ahead.push(change),
        }
    }
    if !ahead.is_empty() {
        cabaret.push(&ahead)?;
        for change in &ahead {
            println!("pushed {change}");
        }
    }
    Ok(())
}
