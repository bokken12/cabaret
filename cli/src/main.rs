use std::{error::Error, process::ExitCode};

use cabaret_lib::{Cabaret, ChangeId, Identity};
use clap::{Parser, Subcommand};

#[derive(Subcommand)]
enum OwnersCommand {
    Show,
    Add { owner: Identity },
    Remove { owner: Identity },
}

#[derive(Subcommand)]
enum ParentsCommand {
    Show,
    Add { parent: ChangeId },
    Remove { parent: ChangeId },
}

#[derive(Subcommand)]
enum ChangeCommand {
    Diff,
    Land,
    Mark,
    Owners {
        #[command(subcommand)]
        command: OwnersCommand,
    },
    Parents {
        #[command(subcommand)]
        command: ParentsCommand,
    },
    Rebase,
}

#[derive(Subcommand)]
enum Command {
    Change {
        #[command(subcommand)]
        command: ChangeCommand,
    },
    Config,
    Fetch,
    Workspace,
}

#[derive(Parser)]
#[command(name = "cab", version, about = "Cabaret Code Review")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cab: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let cabaret = Cabaret::open(std::env::current_dir()?)?;

    match cli.command {
        Command::Change { command } => match command {
            ChangeCommand::Diff => todo!(),
            ChangeCommand::Land => todo!(),
            ChangeCommand::Mark => todo!(),
            ChangeCommand::Owners { command } => {
                let change = &cabaret.current_change()?;
                match command {
                    OwnersCommand::Show => {
                        let change = cabaret.change(change)?;
                        for owner in &change.owners {
                            println!("{owner}");
                        }
                    }
                    OwnersCommand::Add { owner } => cabaret.add_owner(change, &owner)?,
                    OwnersCommand::Remove { owner } => cabaret.remove_owner(change, &owner)?,
                }
            }
            ChangeCommand::Parents { command } => {
                let change = &cabaret.current_change()?;
                match command {
                    ParentsCommand::Show => {
                        let change = cabaret.change(change)?;
                        for parent in &change.parents {
                            println!("{parent}");
                        }
                    }
                    ParentsCommand::Add { parent } => cabaret.add_parent(change, &parent)?,
                    ParentsCommand::Remove { parent } => cabaret.remove_parent(change, &parent)?,
                }
            }
            ChangeCommand::Rebase => todo!(),
        },
        Command::Config => todo!(),
        Command::Fetch => cabaret.fetch()?,
        Command::Workspace => todo!(),
    }

    Ok(())
}
