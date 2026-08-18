use cabaret_lib::{
    cabaret::Cabaret,
    error::Result,
    render::render_home,
    sync::SyncOutcome,
    types::{ChangeId, Identity, Pathspec},
};
use clap::{Parser, Subcommand, ValueHint};

pub mod completion;

use crate::completion::change_completer;

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
    Archive {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(long)]
        undo: bool,
    },
    Create {
        id: ChangeId,
        #[arg(long, add = change_completer())]
        parent: Option<ChangeId>,
    },
    Diff {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        // TODO-someday(joel): cleverer repo-relative path completion
        #[arg(value_hint = ValueHint::AnyPath)]
        pathspecs: Vec<Pathspec>,
    },
    Land {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
    },
    MakePermament {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(long)]
        undo: bool,
    },
    Mark {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
    },
    Owners {
        #[arg(long, global = true, add = change_completer())]
        change: Option<ChangeId>,
        #[command(subcommand)]
        command: OwnersCommand,
    },
    Parents {
        #[arg(long, global = true, add = change_completer())]
        change: Option<ChangeId>,
        #[command(subcommand)]
        command: ParentsCommand,
    },
    Rebase {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(add = change_completer())]
        onto: Option<ChangeId>,
    },
    // TODO-someday(joel): consider merging with `Diff` via flag?
    Review {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
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
        Command::Change { command } => {
            let or_current = |change: Option<ChangeId>| match change {
                Some(change) => Ok(change),
                None => cabaret.current_change(),
            };
            match command {
                ChangeCommand::Archive { change, undo } => cabaret.set_archived(&or_current(change)?, !undo)?,
                ChangeCommand::Create { id, parent } => {
                    let parent = or_current(parent)?;
                    cabaret.create_change(&id, &parent, &cabaret.identity()?)?;
                    println!("created {id} with parent {parent}");
                }
                ChangeCommand::Diff { .. } => todo!(),
                ChangeCommand::Land { change } => cabaret.land(&or_current(change)?)?,
                ChangeCommand::MakePermament { change, undo } => cabaret.set_permanent(&or_current(change)?, !undo)?,
                ChangeCommand::Mark { .. } => todo!(),
                ChangeCommand::Owners { change, command } => {
                    let change = &or_current(change)?;
                    match command {
                        OwnersCommand::Show => {
                            for owner in &cabaret.log(change)?.owners {
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
                            for parent in &cabaret.log(change)?.parents {
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

fn rebase(cabaret: &Cabaret, change: &ChangeId, onto: Option<ChangeId>) -> Result<()> {
    let onto = match onto {
        Some(onto) => onto,
        None => {
            let parents: Vec<ChangeId> = cabaret.parents(change)?.into_iter().collect();
            match parents.as_slice() {
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
            }
        }
    };
    match cabaret.rebase(change, &onto)? {
        None => println!("already up to date"),
        Some(conflicts) => {
            for path in conflicts {
                println!("conflicted: {path}");
            }
        }
    }
    Ok(())
}
