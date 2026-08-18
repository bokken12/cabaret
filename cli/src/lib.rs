use cabaret_lib::{
    cabaret::Cabaret,
    error::Result,
    render::render_home,
    sync::SyncOutcome,
    types::{ChangeId, Identity, Pathspec},
};
use clap::{Parser, Subcommand, ValueHint};

pub mod change;
pub mod completion;

use crate::{change::ChangeCommand, completion::change_completer};

#[derive(Subcommand)]
enum WorkspaceCommand {
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
            let viewer = if let Some(viewer) = viewer { viewer } else { cabaret.identity()? };
            let graph = cabaret.home_graph(&viewer)?;
            if graph.nodes.is_empty() {
                println!("no open changes owned by {viewer}");
            } else {
                print!("{}", render_home(&graph)?.text);
            }
        }
        Command::Workspace { command } => match command {
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
        },
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
