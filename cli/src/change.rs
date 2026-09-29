use std::io::Write;

use cabaret_lib::{
    Cabaret, ChangeId, ChangeIdRef, DiffView, Error, FileDiff, FileVersion, Identity, Pathspec, RepoPath, Result,
    RevisionId, name,
    safeguard::{
        AddParentAllow, ArchiveAllow, CommitAllow, LandAllow, OwnersAllow, PermanenceAllow, RebaseAllow,
        RemoveParentAllow, Safeguard, UnarchiveAllow,
    },
};
use clap::{Subcommand, ValueHint};
use nonempty_collections::{IntoNonEmptyIterator, NEBTreeSet, NEVec, NonEmptyIterator};

use crate::{
    args::{change_completer, parse_revision, revision_completer},
    diff::unified,
};

#[derive(Subcommand)]
pub enum OwnersCommand {
    Show,
    Add {
        owner: Identity,
    },
    Remove {
        owner: Identity,
        /// Remove them even though they are not you.
        #[arg(long)]
        allow_removes_others: bool,
        /// Remove them even though it leaves no owners.
        #[arg(long)]
        allow_ownerless: bool,
    },
    Set {
        owners: Vec<Identity>,
        /// Set them even though owners other than you are dropped.
        #[arg(long)]
        allow_removes_others: bool,
        /// Set them even though there are none.
        #[arg(long)]
        allow_ownerless: bool,
    },
}

#[derive(Subcommand)]
pub enum ParentsCommand {
    Show,
    /// Insert a new change between this one and its parents
    Create {
        name: String,
    },
    Add {
        #[arg(add = change_completer())]
        parent: ChangeId,
        /// Add it even though it is archived.
        #[arg(long)]
        allow_archived_parent: bool,
        /// Add it even though it is already an ancestor of another parent.
        #[arg(long)]
        allow_redundant_parent: bool,
        /// Add it even though the parents would share no ancestor.
        #[arg(long)]
        allow_no_common_ancestor: bool,
    },
    Remove {
        #[arg(add = change_completer())]
        parent: ChangeId,
        /// Remove it even though its work would join the change's diff.
        #[arg(long)]
        allow_base_moves: bool,
        /// Remove it even though the change would have nowhere to land.
        #[arg(long)]
        allow_parentless: bool,
        /// Remove it even though the remaining parents share no ancestor.
        #[arg(long)]
        allow_no_common_ancestor: bool,
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
        /// Archive it even though open changes land into it.
        #[arg(long, conflicts_with = "undo")]
        allow_open_children: bool,
        /// Archive it even though it is permanent.
        #[arg(long, conflicts_with = "undo")]
        allow_permanent: bool,
        /// Unarchive it even though parents it declares are archived.
        #[arg(long, requires = "undo")]
        allow_archived_parents: bool,
    },
    Commit {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(value_hint = ValueHint::AnyPath)]
        pathspecs: Vec<Pathspec>,
        /// Commit even though it adds conflict markers.
        #[arg(long)]
        allow_conflicted: bool,
    },
    Create {
        name: String,
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
    /// List the files the change's diff touches, or show diffs of those matching the given pathspecs.
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
    /// Drop the workspace's uncommitted changes at the given paths, back to the change's tip
    Discard {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(required = true, value_hint = ValueHint::AnyPath)]
        pathspecs: Vec<Pathspec>,
    },
    Land {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        /// Land even though owners have files left to review.
        #[arg(long)]
        allow_unreviewed: bool,
        /// Land even though you do not own it.
        #[arg(long)]
        allow_non_owner: bool,
        /// Land even though the parent's owners have files of it left to review.
        #[arg(long)]
        allow_parent_unreviewed: bool,
        /// Land even though it adds nothing, just archiving it.
        #[arg(long)]
        allow_empty: bool,
        /// Land even though it leaves the parent holding conflict markers.
        #[arg(long)]
        allow_conflicted: bool,
        /// Land even though its workspace has uncommitted changes.
        #[arg(long)]
        allow_uncommitted: bool,
    },
    #[command(alias = "make-permament")]
    MakePermanent {
        #[arg(long, add = change_completer())]
        change: Option<ChangeId>,
        #[arg(long)]
        undo: bool,
        /// Change it even though you do not own it.
        #[arg(long)]
        allow_non_owner: bool,
        /// Make it permanent even though its parents are not.
        #[arg(long)]
        allow_impermanent_parents: bool,
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
        /// Rebase even though you do not own it.
        #[arg(long)]
        allow_non_owner: bool,
        /// Rebase even though it has conflicts of its own left to resolve.
        #[arg(long)]
        allow_conflicted: bool,
        /// Rebase even though a parent holds conflicts, which would come along.
        #[arg(long)]
        allow_parent_conflicted: bool,
    },
    /// List the files you have left to review, or show diffs of those matching the given pathspecs:
    /// each as the tip differs from the merge of the change's bases with the tip you last marked it reviewed at.
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
            ChangeCommand::Archive { change, undo, allow_open_children, allow_permanent, allow_archived_parents } => {
                let change = or_current(change)?;
                match undo {
                    false => {
                        let allow = ArchiveAllow { open_children: allow_open_children, permanent: allow_permanent };
                        cabaret
                            .archive(&change, allow)?
                            .map_err(|refused| refusal(&format!("archive {change}"), refused))?;
                    }
                    true => {
                        let allow = UnarchiveAllow { archived_parents: allow_archived_parents };
                        cabaret
                            .unarchive(&change, allow)?
                            .map_err(|refused| refusal(&format!("unarchive {change}"), refused))?;
                    }
                }
            }
            ChangeCommand::Commit { change, pathspecs, allow_conflicted } => {
                let change = or_current(change)?;
                cabaret
                    .commit(&change, &pathspecs, CommitAllow { conflicted: allow_conflicted })?
                    .map_err(|refused| refusal(&format!("commit to {change}"), refused))?;
                println!("committed to {change}");
            }
            ChangeCommand::Create { name, parent, child } => {
                let owner = &cabaret.identity()?;
                match (child, NEVec::try_from_vec(parent)) {
                    (Some(_), Some(_)) => Err("cannot pass both --parent and --child")?,
                    (Some(child), None) => {
                        let id = cabaret.create_parent(&name, &child, owner)?;
                        println!("created {id} as parent of {child}");
                    }
                    (None, Some(parents)) => {
                        let id = cabaret.create(&name, parents.into_nonempty_iter().collect(), owner)?;
                        // TODO(joel): informative message
                        println!("created {id}");
                    }
                    (None, None) => {
                        let parent = cabaret.current_change()?;
                        let id = cabaret.create(&name, NEBTreeSet::new(parent.clone()), owner)?;
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
                let view = match workspace {
                    false => DiffView::Diff,
                    true => DiffView::Workspace,
                };
                diff(&cabaret, &or_current(change)?, view, &pathspecs)?;
            }
            ChangeCommand::Discard { change, pathspecs } => {
                let change = or_current(change)?;
                cabaret.discard(&change, &pathspecs)?;
                println!("discarded from {change}");
            }
            ChangeCommand::Land {
                change,
                allow_unreviewed,
                allow_non_owner,
                allow_parent_unreviewed,
                allow_empty,
                allow_conflicted,
                allow_uncommitted,
            } => {
                let change = or_current(change)?;
                let allow = LandAllow {
                    unreviewed: allow_unreviewed,
                    non_owner: allow_non_owner,
                    parent_unreviewed: allow_parent_unreviewed,
                    empty: allow_empty,
                    conflicted: allow_conflicted,
                    uncommitted: allow_uncommitted,
                };
                let parent =
                    cabaret.land(&change, allow)?.map_err(|refused| refusal(&format!("land {change}"), refused))?;
                println!("landed {change} into {parent}");
            }
            ChangeCommand::MakePermanent { change, undo, allow_non_owner, allow_impermanent_parents } => {
                let change = or_current(change)?;
                let allow =
                    PermanenceAllow { non_owner: allow_non_owner, impermanent_parents: allow_impermanent_parents };
                let action = format!("make {change} {}", if undo { "impermanent" } else { "permanent" });
                cabaret.set_permanent(&change, !undo, allow)?.map_err(|refused| refusal(&action, refused))?;
            }
            ChangeCommand::Mark { change, tip, files } => {
                cabaret.mark(&or_current(change)?, &files, tip)?;
            }
            ChangeCommand::Owners { change, command } => {
                let change = &or_current(change)?;
                match command {
                    OwnersCommand::Show => return Err("change owners show is not implemented yet".into()),
                    OwnersCommand::Add { owner } => cabaret.add_owner(change, &owner)?,
                    OwnersCommand::Remove { owner, allow_removes_others, allow_ownerless } => {
                        let allow = OwnersAllow { removes_others: allow_removes_others, ownerless: allow_ownerless };
                        cabaret
                            .remove_owner(change, &owner, allow)?
                            .map_err(|refused| refusal(&format!("remove {owner} as an owner of {change}"), refused))?;
                    }
                    OwnersCommand::Set { owners, allow_removes_others, allow_ownerless } => {
                        let allow = OwnersAllow { removes_others: allow_removes_others, ownerless: allow_ownerless };
                        cabaret
                            .set_owners(change, owners.into_iter().collect(), allow)?
                            .map_err(|refused| refusal(&format!("set the owners of {change}"), refused))?;
                    }
                }
            }
            ChangeCommand::Parents { change, command } => {
                let change = &or_current(change)?;
                match command {
                    ParentsCommand::Show => return Err("change parents show is not implemented yet".into()),
                    ParentsCommand::Create { name } => {
                        let id = cabaret.create_parent(&name, change, &cabaret.identity()?)?;
                        println!("created {id} as parent of {change}");
                    }
                    ParentsCommand::Add {
                        parent,
                        allow_archived_parent,
                        allow_redundant_parent,
                        allow_no_common_ancestor,
                    } => {
                        let allow = AddParentAllow {
                            archived_parent: allow_archived_parent,
                            redundant_parent: allow_redundant_parent,
                            no_common_ancestor: allow_no_common_ancestor,
                        };
                        cabaret
                            .add_parent(change, &parent, allow)?
                            .map_err(|refused| refusal(&format!("add {parent} as a parent of {change}"), refused))?;
                    }
                    ParentsCommand::Remove { parent, allow_base_moves, allow_parentless, allow_no_common_ancestor } => {
                        let allow = RemoveParentAllow {
                            base_moves: allow_base_moves,
                            parentless: allow_parentless,
                            no_common_ancestor: allow_no_common_ancestor,
                        };
                        cabaret
                            .remove_parent(change, &parent, allow)?
                            .map_err(|refused| refusal(&format!("remove {parent} as a parent of {change}"), refused))?;
                    }
                    ParentsCommand::Set { parents: _ } => {
                        return Err("change parents set is not implemented yet".into());
                    }
                }
            }
            ChangeCommand::Rebase { change, onto, allow_non_owner, allow_conflicted, allow_parent_conflicted } => {
                let allow = RebaseAllow {
                    non_owner: allow_non_owner,
                    conflicted: allow_conflicted,
                    parent_conflicted: allow_parent_conflicted,
                };
                rebase(&cabaret, &or_current(change)?, onto.as_deref(), allow)?;
            }
            ChangeCommand::Review { change, pathspecs } => {
                diff(&cabaret, &or_current(change)?, DiffView::Review, &pathspecs)?;
            }
            ChangeCommand::Show { change } => print!("{}", cabaret.show_page(&or_current(change)?)?),
            ChangeCommand::Todo { change: _ } => {
                return Err("change todo is not implemented yet".into());
            }
        }

        Ok(())
    }
}

/// The files `change`'s `view` touches, or with pathspecs the diffs of those matching: reading
/// every diff at once is rarely wanted, so it takes asking for.
fn diff(cabaret: &Cabaret, change: &ChangeIdRef, view: DiffView, pathspecs: &[Pathspec]) -> Result<()> {
    match pathspecs.is_empty() {
        true => print!("{}", cabaret.files_page(change, view, pathspecs)?),
        false => {
            let diff = cabaret.view_diff(change, view, pathspecs)?;
            let mut out = std::io::stdout().lock();
            let kind = view.kind();
            writeln!(out, "{} · {kind} files at {}\n", name(change, cabaret.title(change)?.as_deref()), diff.tip)?;
            if diff.files.is_empty() {
                writeln!(out, "no {kind} files")?;
            }
            let version = |revision: Option<RevisionId>, path: &RepoPath| -> Result<Option<FileVersion>> {
                let Some(revision) = revision else { return Ok(None) };
                Ok(Some(cabaret.blob(revision, path)?.expect("a changed file is on the side it differs on")))
            };
            for FileDiff { file, before, after } in &diff.files {
                let (before, after) = (version(*before, file.source())?, version(*after, file.path())?);
                out.write_all(&unified(file, before.as_ref(), after.as_ref()))?;
            }
        }
    }
    Ok(())
}

fn rebase(cabaret: &Cabaret, change: &ChangeId, onto: Option<&ChangeIdRef>, allow: RebaseAllow) -> Result<()> {
    let words = |ids: Vec<String>| ids.join(", ");
    let rebase =
        cabaret.rebase(change, onto, allow)?.map_err(|refused| refusal(&format!("rebase {change}"), refused))?;
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

/// Why `action` was refused, naming the flag that allows each safeguard. The flags are spelled
/// `--allow-<kind>` on every command.
pub fn refusal(action: &str, refused: NEVec<impl Into<Safeguard>>) -> Error {
    let reasons: Vec<String> = refused
        .into_iter()
        .map(Into::into)
        .map(|safeguard: Safeguard| format!("{safeguard}; pass --allow-{} to override", safeguard.kind()))
        .collect();
    match reasons.as_slice() {
        [reason] => format!("cannot {action}: {reason}"),
        _ => format!("cannot {action}:\n  {}", reasons.join("\n  ")),
    }
    .into()
}
