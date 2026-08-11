use std::process::ExitCode;

use cabaret_lib::{Cabaret, ChangeId, Identity, Rebase, Result};
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
    Rebase {
        onto: Option<ChangeId>,
    },
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
            eprintln!("cab: {error:?}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
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
            ChangeCommand::Rebase { onto } => {
                let change = cabaret.current_change()?;
                let parents = cabaret.change(&change)?.parents;
                let onto = choose_parent(&change, &parents, onto)?;
                match cabaret.rebase(&change, &onto)? {
                    Rebase::UpToDate => println!("already up to date"),
                    Rebase::Merged { conflicts } => {
                        for path in conflicts {
                            println!("conflicted: {path}");
                        }
                    }
                }
            }
        },
        Command::Config => todo!(),
        Command::Fetch => cabaret.fetch()?,
        Command::Workspace => todo!(),
    }

    Ok(())
}

fn choose_parent(
    change: &ChangeId,
    parents: &std::collections::BTreeSet<ChangeId>,
    onto: Option<ChangeId>,
) -> Result<ChangeId> {
    match onto {
        Some(onto) => {
            if !parents.contains(&onto) {
                return Err(format!("{onto} is not a parent of {change}").into());
            }
            Ok(onto)
        }
        None => match parents.len() {
            0 => Err(format!("{change} has no parents").into()),
            1 => Ok(parents.first().expect("len is 1").clone()),
            _ => {
                let parents: Vec<String> = parents.iter().map(ToString::to_string).collect();
                Err(format!("{change} has multiple parents; pass the one to rebase onto: {}", parents.join(", "))
                    .into())
            }
        },
    }
}
