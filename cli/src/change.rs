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
    /// Set the change's description, given or else read from stdin; blank clears it.
    Describe {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        description: Option<String>,
    },
    Diff {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        /// Show what the change's workspace has on disk beyond its tip, instead of the change's own diff.
        #[arg(long)]
        workspace: bool,
        // TODO-someday(joel): cleverer repo-relative path completion
        #[arg(value_hint = ValueHint::AnyPath)]
        pathspecs: Vec<Pathspec>,
    },
    Land {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
    },
    #[command(alias = "make-permament")]
    MakePermanent {
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
    /// Show the files you have left to review: each as the tip differs from the merge of the
    /// change's bases with the tip you last marked it reviewed at.
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
    /// Search a change's diff for TODOs to be resolved within it.
    Todo {
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
            ChangeCommand::Describe { change, description } => {
                let text = match description {
                    Some(text) => text,
                    None => std::io::read_to_string(std::io::stdin())?,
                };
                cabaret.set_description(&or_current(change)?, Some(text).filter(|text| !text.trim().is_empty()))?;
            }
            ChangeCommand::Diff { change, workspace, pathspecs } => {
                // TODO(joel): show file content not just file names
                let change = or_current(change)?;
                match workspace {
                    false => print!("{}", cabaret.diff_page(&change, &pathspecs)?),
                    true => print!("{}", cabaret.workspace_page(&change, &pathspecs)?),
                }
            }
            ChangeCommand::Land { change } => {
                let change = or_current(change)?;
                let parent = cabaret.land(&change)?;
                println!("landed {change} into {parent}");
            }
            ChangeCommand::MakePermanent { change, undo } => cabaret.set_permanent(&or_current(change)?, !undo)?,
            ChangeCommand::Mark { change, tip, files } => {
                cabaret.mark(&or_current(change)?, &files, tip)?;
            }
            ChangeCommand::Owners { change, command } => {
                let change = &or_current(change)?;
                match command {
                    OwnersCommand::Show => return Err("change owners show is not implemented yet".into()),
                    OwnersCommand::Add { owner } => cabaret.add_owner(change, &owner)?,
                    OwnersCommand::Remove { owner } => cabaret.remove_owner(change, &owner)?,
                    OwnersCommand::Set { owners } => cabaret.set_owners(change, owners.into_iter().collect())?,
                }
            }
            ChangeCommand::Parents { change, command } => {
                let change = &or_current(change)?;
                match command {
                    ParentsCommand::Show => return Err("change parents show is not implemented yet".into()),
                    ParentsCommand::Create { id } => {
                        cabaret.create_parent(&id, change, &cabaret.identity()?)?;
                        println!("created {id} as parent of {change}");
                    }
                    ParentsCommand::Add { parent } => cabaret.add_parent(change, &parent)?,
                    ParentsCommand::Remove { parent } => cabaret.remove_parent(change, &parent)?,
                    ParentsCommand::Set { parents: _ } => {
                        return Err("change parents set is not implemented yet".into());
                    }
                }
            }
            ChangeCommand::Rebase { change, onto } => rebase(&cabaret, &or_current(change)?, onto.as_deref())?,
            ChangeCommand::Review { change, pathspecs } => {
                print!("{}", cabaret.review_page(&or_current(change)?, &pathspecs)?);
            }
            ChangeCommand::Show { change } => print!("{}", cabaret.show_page(&or_current(change)?)?),
            ChangeCommand::Todo { change: _ } => {
                return Err("change todo is not implemented yet".into());
            }
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
