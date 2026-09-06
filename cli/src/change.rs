use cabaret_lib::{Cabaret, ChangeId, ChangeIdRef, Identity, Pathspec, RepoPath, Result, RevisionId};
use clap::{Subcommand, ValueHint};
use nonempty_collections::{IntoNonEmptyIterator, NEBTreeSet, NEVec, NonEmptyIterator};

use crate::args::{change_completer, parse_revision, revision_completer};

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
    /// Insert a new change between this one and its parents
    Create {
        id: ChangeId,
    },
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
    Commit {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(value_hint = ValueHint::AnyPath)]
        pathspecs: Vec<Pathspec>,
    },
    Create {
        id: ChangeId,
        #[arg(long, add = change_completer())]
        parent: Vec<ChangeId>,
        #[arg(long, add = change_completer(), conflicts_with = "parent")]
        child: Option<ChangeId>,
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
    /// Mark files as reviewed by you.
    Mark {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        /// Revision reviewed up to; defaults to the change's tip.
        #[arg(long, value_parser = parse_revision, add = revision_completer())]
        tip: Option<RevisionId>,
        /// Revision reviewed from, repeatable; defaults to the change's bases.
        #[arg(long, value_parser = parse_revision, add = revision_completer())]
        base: Vec<RevisionId>,
        // TODO-someday(joel): accept paths relative to the working directory
        #[arg(required = true, value_hint = ValueHint::AnyPath)]
        files: Vec<RepoPath>,
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
    Show {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
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
            ChangeCommand::Commit { change, pathspecs } => {
                let change = or_current(change)?;
                cabaret.commit(&change, &pathspecs)?;
                println!("committed to {change}");
            }
            ChangeCommand::Create { id, parent, child } => {
                let owner = &cabaret.identity()?;
                match (child, NEVec::try_from_vec(parent)) {
                    (Some(_), Some(_)) => Err("cannot pass both --parent and --child")?,
                    (Some(child), None) => {
                        cabaret.create_parent(&id, &child, owner)?;
                        println!("created {id} as parent of {child}");
                    }
                    (None, Some(parents)) => {
                        cabaret.create(&id, parents.into_nonempty_iter().collect(), owner)?;
                        // TODO(joel): informative message
                        println!("created {id}");
                    }
                    (None, None) => {
                        let parent = cabaret.current_change()?;
                        cabaret.create(&id, NEBTreeSet::new(parent.clone()), owner)?;
                        println!("created {id} with parent {parent}");
                    }
                }
            }
            ChangeCommand::Diff { change, pathspecs } => {
                // TODO(joel): show file content not just file names
                print!("{}", cabaret.diff_page(&or_current(change)?, &pathspecs)?);
            }
            ChangeCommand::Land { change } => {
                let change = or_current(change)?;
                let parent = cabaret.land(&change)?;
                println!("landed {change} into {parent}");
            }
            ChangeCommand::MakePermament { change, undo } => cabaret.set_permanent(&or_current(change)?, !undo)?,
            ChangeCommand::Mark { change, tip, base, files } => {
                let bases = match base.is_empty() {
                    true => None,
                    false => Some(base.into_iter().collect()),
                };
                cabaret.mark(&or_current(change)?, &files, tip, bases)?;
            }
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
                    ParentsCommand::Create { id } => {
                        cabaret.create_parent(&id, change, &cabaret.identity()?)?;
                        println!("created {id} as parent of {change}");
                    }
                    ParentsCommand::Add { parent } => cabaret.add_parent(change, &parent)?,
                    ParentsCommand::Remove { parent } => cabaret.remove_parent(change, &parent)?,
                    ParentsCommand::Set { parents } => todo!(),
                }
            }
            ChangeCommand::Rebase { change, onto } => rebase(&cabaret, &or_current(change)?, onto.as_deref())?,
            ChangeCommand::Review { .. } => todo!(),
            ChangeCommand::Show { change } => print!("{}", cabaret.show_page(&or_current(change)?)?),
        }

        Ok(())
    }
}

fn rebase(cabaret: &Cabaret, change: &ChangeId, onto: Option<&ChangeIdRef>) -> Result<()> {
    let words = |ids: Vec<String>| ids.join(", ");
    let rebase = cabaret.rebase(change, onto)?;
    match rebase.merged.is_empty() {
        true => println!("{change} is already up to date"),
        false => println!("rebased {change} onto {}", words(rebase.merged.iter().map(ToString::to_string).collect())),
    }
    if !rebase.conflicts.is_empty() {
        println!("conflicts in {}", words(rebase.conflicts.iter().map(ToString::to_string).collect()));
    }
    if !rebase.remaining.is_empty() {
        let remaining = words(rebase.remaining.iter().map(ToString::to_string).collect());
        println!("resolve them and rebase again to continue onto {remaining}");
    }
    Ok(())
}
