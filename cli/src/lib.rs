use std::path::PathBuf;

use cabaret_lib::{Cabaret, Identity, Pathspec, Result};
use clap::{Parser, Subcommand, ValueHint};

pub mod args;
pub mod change;
pub mod workspace;

use crate::{change::ChangeCommand, workspace::WorkspaceCommand};

#[derive(Subcommand)]
enum Command {
    Change {
        #[command(subcommand)]
        command: ChangeCommand,
    },
    Config,
    Fetch,
    /// Show your open changes as a stack graph.
    Home {
        /// Identity to view as; defaults to git's user.email.
        #[arg(long = "as")]
        viewer: Option<Identity>,
    },
    /// Make a new repository. An empty directory gets one laid out with a workspace per change
    /// beside it; a directory with contents becomes the main workspace, as git init does.
    Init {
        /// Directory to initialize in
        #[arg(value_hint = ValueHint::DirPath)]
        dir: Option<PathBuf>,
        /// Clone this repository instead of starting empty.
        #[arg(long)]
        from: Option<String>,
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
    let cabaret = || Cabaret::open(std::env::current_dir()?);

    match cli.command {
        Command::Change { command } => command.run(cabaret()?)?,
        Command::Config => todo!(),
        Command::Fetch => fetch(&cabaret()?)?,
        Command::Home { viewer } => {
            let cabaret = cabaret()?;
            let viewer = match viewer {
                Some(viewer) => viewer,
                None => cabaret.identity()?,
            };
            print!("{}", cabaret.home_page(&viewer)?);
        }
        Command::Init { dir, from } => {
            let dir = match dir {
                Some(dir) => dir,
                None => std::env::current_dir()?,
            };
            Cabaret::init(&dir, from.as_deref())?;
        }
        Command::Workspace { command } => command.run(cabaret()?)?,
    }

    Ok(())
}

fn fetch(cabaret: &Cabaret) -> Result<()> { todo!() }
