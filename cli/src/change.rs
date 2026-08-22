use cabaret_lib::{
    cabaret2::Cabaret,
    change::ChangeId,
    error::Result,
    types::{Identity, Pathspec},
};
use clap::{Subcommand, ValueHint};

use crate::completion::change_completer;

#[derive(Subcommand)]
pub enum OwnersCommand {
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
pub enum ParentsCommand {
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
pub enum ChangeCommand {
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

impl ChangeCommand {
    pub fn run(self, cabaret: Cabaret) -> Result<()> {
        let or_current = |change: Option<ChangeId>| match change {
            Some(change) => Ok(change),
            None => cabaret.current_change(),
        };
        match self {
            ChangeCommand::Archive { change, undo } => match undo {
                false => cabaret.archive(&or_current(change)?)?,
                true => cabaret.unarchive(&or_current(change)?)?,
            },
            ChangeCommand::Create { id, parent } => {
                let parent = or_current(parent)?;
                cabaret.create(&id, &parent, &cabaret.identity()?)?;
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
                        todo!()
                    }
                    OwnersCommand::Add { owner } => cabaret.add_owner(change, &owner)?,
                    OwnersCommand::Remove { owner } => cabaret.remove_owner(change, &owner)?,
                    OwnersCommand::Set { owners } => cabaret.set_owners(change, owners.into_iter().collect())?,
                }
            }
            ChangeCommand::Parents { change, command } => {
                let change = &or_current(change)?;
                match command {
                    ParentsCommand::Show => {
                        todo!()
                    }
                    ParentsCommand::Add { parent } => todo!(),
                    ParentsCommand::Remove { parent } => todo!(),
                    ParentsCommand::Set { parents } => todo!(),
                }
            }
            ChangeCommand::Rebase { change, onto } => rebase(&cabaret, &or_current(change)?, onto)?,
            ChangeCommand::Review { .. } => todo!(),
        }

        Ok(())
    }
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
    cabaret.rebase(change, &onto)
}
