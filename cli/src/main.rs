use std::{ffi::OsStr, process::ExitCode};

use cabaret_lib::{Cabaret, ChangeId, Identity, Pathspec, Result, SyncOutcome, render_home};
use clap::{CommandFactory, Parser, Subcommand, ValueHint};
use clap_complete::{ArgValueCompleter, CompleteEnv, CompletionCandidate};

fn change_completer() -> ArgValueCompleter {
    fn changes() -> Result<Vec<ChangeId>> { Cabaret::open(std::env::current_dir()?)?.changes() }
    ArgValueCompleter::new(|current: &OsStr| {
        let Some(current) = current.to_str() else { return Vec::new() };
        changes()
            .unwrap_or_default()
            .into_iter()
            .map(|change| change.to_string())
            .filter(|change| change.starts_with(current))
            .map(CompletionCandidate::new)
            .collect()
    })
}

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
        #[arg(add = change_completer())]
        parent: ChangeId,
    },
    Remove {
        #[arg(add = change_completer())]
        parent: ChangeId,
    },
    Set {
        #[arg(required = true, add = change_completer())]
        parents: Vec<ChangeId>,
    },
}

#[derive(Subcommand)]
enum ChangeCommand {
    Create {
        /// ID of the new change.
        id: ChangeId,
        /// Parent of the new change; defaults to the current change.
        #[arg(long, add = change_completer())]
        parent: Option<ChangeId>,
    },
    Diff {
        /// Change to operate on; defaults to the current change.
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        // TODO-someday(joel): cleverer repo-relative path completion
        /// Files or globs to diff; diffs everything when omitted.
        #[arg(value_hint = ValueHint::AnyPath)]
        pathspecs: Vec<Pathspec>,
    },
    Land {
        /// Change to operate on; defaults to the current change.
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
    },
    Mark {
        /// Change to operate on; defaults to the current change.
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
    },
    Owners {
        /// Change to operate on; defaults to the current change.
        #[arg(long, global = true, add = change_completer())]
        change: Option<ChangeId>,
        #[command(subcommand)]
        command: OwnersCommand,
    },
    Parents {
        /// Change to operate on; defaults to the current change.
        #[arg(long, global = true, add = change_completer())]
        change: Option<ChangeId>,
        #[command(subcommand)]
        command: ParentsCommand,
    },
    Rebase {
        /// Change to operate on; defaults to the current change.
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(add = change_completer())]
        onto: Option<ChangeId>,
    },
    // TODO-someday(joel): consider merging with `Diff` via flag?
    Review {
        /// Change to operate on; defaults to the current change.
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        /// Files or globs to review; reviews everything when omitted.
        #[arg(value_hint = ValueHint::AnyPath)]
        pathspecs: Vec<Pathspec>,
    },
}

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
        /// Files or globs to commit; commits everything when omitted.
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
struct Cli {
    #[command(subcommand)]
    command: Command,
}

fn main() -> ExitCode {
    CompleteEnv::with_factory(Cli::command).complete();
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
        Command::Change { command } => {
            let or_current = |change: Option<ChangeId>| match change {
                Some(change) => Ok(change),
                None => cabaret.current_change(),
            };
            match command {
                ChangeCommand::Create { id, parent } => {
                    let parent = or_current(parent)?;
                    cabaret.create_change(&id, &parent)?;
                    println!("created {id} with parent {parent}");
                }
                ChangeCommand::Diff { .. } => todo!(),
                ChangeCommand::Land { change } => land(&cabaret, &or_current(change)?)?,
                ChangeCommand::Mark { .. } => todo!(),
                ChangeCommand::Owners { change, command } => {
                    let change = &or_current(change)?;
                    match command {
                        OwnersCommand::Show => {
                            let change = cabaret.change(change)?;
                            for owner in &change.owners {
                                println!("{owner}");
                            }
                        }
                        OwnersCommand::Add { owner } => cabaret.add_owner(change, &owner)?,
                        OwnersCommand::Remove { owner } => cabaret.remove_owner(change, &owner)?,
                        OwnersCommand::Set { owners } => cabaret.set_owners(change, &owners.into_iter().collect())?,
                    }
                }
                ChangeCommand::Parents { change, command } => {
                    let change = &or_current(change)?;
                    match command {
                        ParentsCommand::Show => {
                            let change = cabaret.change(change)?;
                            for parent in &change.parents {
                                println!("{parent}");
                            }
                        }
                        ParentsCommand::Add { parent } => cabaret.add_parent(change, &parent)?,
                        ParentsCommand::Remove { parent } => cabaret.remove_parent(change, &parent)?,
                        ParentsCommand::Set { parents } => {
                            cabaret.set_parents(change, &parents.into_iter().collect())?;
                        }
                    }
                }
                ChangeCommand::Rebase { change, onto } => rebase(&cabaret, &or_current(change)?, onto)?,
                ChangeCommand::Review { .. } => todo!(),
            }
        }
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

fn land(cabaret: &Cabaret, change: &ChangeId) -> Result<()> {
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
    Ok(())
}

fn rebase(cabaret: &Cabaret, change: &ChangeId, onto: Option<ChangeId>) -> Result<()> {
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
    Ok(())
}
