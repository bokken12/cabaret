use std::{io::IsTerminal, process::ExitCode};

use cabaret_lib::{Cabaret, ChangeId, Identity, Pathspec, Result};
use clap::{Parser, Subcommand};

#[derive(Subcommand)]
enum OwnersCommand {
    Show,
    Add {
        owner: Identity,
    },
    Remove {
        owner: Identity,
    },
    Set {
        #[arg(required = true)]
        owners: Vec<Identity>,
    },
}

#[derive(Subcommand)]
enum ParentsCommand {
    Show,
    Add {
        parent: ChangeId,
    },
    Remove {
        parent: ChangeId,
    },
    Set {
        #[arg(required = true)]
        parents: Vec<ChangeId>,
    },
}

#[derive(Subcommand)]
enum ChangeCommand {
    Diff {
        /// Files or globs to diff; diffs everything when omitted.
        pathspecs: Vec<Pathspec>,
    },
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
    // TODO-someday(joel): consider merging with `Diff` via flag?
    Review {
        /// Files or globs to review; reviews everything when omitted.
        pathspecs: Vec<Pathspec>,
    },
}

#[derive(Subcommand)]
enum Command {
    Change {
        /// Change to operate on; defaults to the current change.
        #[arg(long, global = true)]
        change: Option<ChangeId>,
        #[command(subcommand)]
        command: ChangeCommand,
    },
    Commit {
        /// Files or globs to commit; commits everything when omitted.
        pathspecs: Vec<Pathspec>,
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
        Command::Change { change, command } => {
            let change = &match change {
                Some(change) => change,
                None => cabaret.current_change()?,
            };
            match command {
                ChangeCommand::Diff { pathspecs } => {
                    let mut diff = cabaret.diff(change)?;
                    diff.files = cabaret.select(diff.files, pathspecs)?;
                    print!("{}", cabaret.render_diff(&diff, std::io::stdout().is_terminal())?);
                }
                ChangeCommand::Land => {
                    let parents: Vec<ChangeId> = cabaret.change(change)?.parents.into_iter().collect();
                    let parent = match parents.as_slice() {
                        [] => return Err(format!("{change} has no parents").into()),
                        [parent] => parent.clone(),
                        [_, _, ..] => return Err(format!("{change} has multiple parents; cannot land").into()),
                    };

                    match cabaret.prepare_merge(&parent, change)? {
                        None => println!("nothing to land"),
                        Some(merge) if !merge.conflicts().is_empty() => {
                            for path in merge.conflicts() {
                                println!("conflicted: {path}");
                            }
                            return Err(format!("landing {change} would conflict; rebase and resolve first").into());
                        }
                        Some(merge) => {
                            // TODO(joel): archive and reparent children?
                            cabaret.commit_merge(merge, format!("land {change}"))?;
                            println!("landed {change} into {parent}");
                        }
                    }
                }
                ChangeCommand::Mark => todo!(),
                ChangeCommand::Owners { command } => match command {
                    OwnersCommand::Show => {
                        let change = cabaret.change(change)?;
                        for owner in &change.owners {
                            println!("{owner}");
                        }
                    }
                    OwnersCommand::Add { owner } => cabaret.add_owner(change, &owner)?,
                    OwnersCommand::Remove { owner } => cabaret.remove_owner(change, &owner)?,
                    OwnersCommand::Set { owners } => cabaret.set_owners(change, &owners.into_iter().collect())?,
                },
                ChangeCommand::Parents { command } => match command {
                    ParentsCommand::Show => {
                        let change = cabaret.change(change)?;
                        for parent in &change.parents {
                            println!("{parent}");
                        }
                    }
                    ParentsCommand::Add { parent } => cabaret.add_parent(change, &parent)?,
                    ParentsCommand::Remove { parent } => cabaret.remove_parent(change, &parent)?,
                    ParentsCommand::Set { parents } => cabaret.set_parents(change, &parents.into_iter().collect())?,
                },
                ChangeCommand::Rebase { onto } => {
                    let parents: Vec<ChangeId> = cabaret.change(change)?.parents.into_iter().collect();
                    let onto = match onto {
                        Some(onto) if parents.contains(&onto) => onto,
                        Some(onto) => return Err(format!("{onto} is not a parent of {change}").into()),
                        None => match parents.as_slice() {
                            [] => return Err(format!("{change} has no parents").into()),
                            [parent] => parent.clone(),
                            parents @ [_, _, ..] => {
                                let parents: Vec<String> = parents.iter().map(ToString::to_string).collect();
                                return Err(format!(
                                    "{change} has multiple parents; pass the one to rebase onto: {}",
                                    parents.join(", ")
                                )
                                .into());
                            }
                        },
                    };
                    match cabaret.prepare_merge(change, &onto)? {
                        None => println!("already up to date"),
                        Some(merge) => {
                            let conflicts = merge.conflicts().to_vec();
                            cabaret.commit_merge(merge, format!("rebase onto {onto}"))?;
                            for path in conflicts {
                                println!("conflicted: {path}");
                            }
                        }
                    }
                }
                ChangeCommand::Review { .. } => todo!(),
            }
        }
        Command::Commit { .. } => todo!(),
        Command::Config => todo!(),
        Command::Fetch => cabaret.fetch()?,
        Command::Workspace => todo!(),
    }

    Ok(())
}
