use std::collections::{BTreeMap, BTreeSet, btree_map};

use serde::{Deserialize, Serialize};

use crate::{
    cabaret::Cabaret,
    change_id::{ChangeId, ChangeIdRef},
    error::Result,
    revision::{Revision, RevisionRange},
    types::{Identity, RepoPath, TimestampMs},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    Forget { user: Identity, file: RepoPath },
    Mark { user: Identity, file: RepoPath, range: RevisionRange },
    RemoveOwner { owner: Identity },
    RemoveParent { parent: ChangeId },
    SetArchived { archived: bool },
    SetDescription { description: Option<String> },
    SetPermanent { permanent: bool },
    SetTitle { title: Option<String> },
}

// TODO-someday(joel): allow format evolution. protos? versioned?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: TimestampMs,
    // TODO-someday(joel): add user
    // pub user: String,
    #[serde(flatten)]
    pub action: LogAction,
}

fn set<T: PartialEq + Clone>(place: &mut T, val: &T) -> bool {
    let changed = place != val;
    *place = val.clone();
    changed
}

fn set_key<K: Ord, T: PartialEq + Clone>(map: &mut BTreeMap<K, T>, k: K, val: &T) -> bool {
    match map.entry(k) {
        btree_map::Entry::Vacant(v) => {
            v.insert(val.clone());
            true
        }
        btree_map::Entry::Occupied(mut o) => set(o.get_mut(), val),
    }
}

fn remove_key<K: Ord, T>(map: &mut BTreeMap<K, T>, k: &K) -> bool { map.remove(k).is_some() }

/// A change's log: its stored form plus the fold of its actions.
// TODO-someday(joel): consider how to properly control lifecycle?
// TODO(joel: this should never have to cross the napi boundary
// #[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
// pub struct Log {
//     pub head: Revision,
//     pub text: String,
//     // TODO-someday(joel): add other relevant data
//     pub title: Option<String>,
//     pub description: Option<String>,
//     pub liveness: Liveness,
//     pub owners: BTreeSet<Identity>,
//     pub parents: BTreeSet<ChangeId>,
//     pub review_state: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
// }

// impl Log {
//     /// `log.apply(action)` is `true` iff `action` modifies `log`.
//     pub fn apply(&mut self, action: &LogAction) -> bool {
//         match action {
//             LogAction::AddOwner { owner } => self.owners.insert(owner.clone()),
//             LogAction::AddParent { parent } => self.parents.insert(parent.clone()),
//             LogAction::Forget { user, file } => remove_key(self.review_state.entry(user.clone()).or_default(), file),
//             LogAction::Mark { user, file, range } => {
//                 set_key(self.review_state.entry(user.clone()).or_default(), file.clone(), range)
//             }
//             LogAction::RemoveOwner { owner } => self.owners.remove(owner),
//             LogAction::RemoveParent { parent } => self.parents.remove(parent),
//             LogAction::SetDescription { description } => set(&mut self.description, description),
//             LogAction::SetLiveness { liveness } => set(&mut self.liveness, liveness),
//             LogAction::SetTitle { title } => set(&mut self.title, title),
//         }
//     }
// }

const LOG_FILE: &str = "log.jsonl";
