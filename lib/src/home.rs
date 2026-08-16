use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::{
    cabaret::Cabaret,
    error::Result,
    types::{Change, ChangeId, Identity},
};

// TODO(jm): audit LLM

/// A change in the home view: owned by the viewer, or an open ancestor shown as context.
pub struct HomeNode {
    pub title: Option<String>,
    pub owned: bool,
    /// Parents that are themselves nodes of the same graph. Parents that are not open changes
    /// (trunk branches like main) are dropped: rooting on trunk and having no parents are the
    /// same state, and trunk is never drawn.
    pub parents: BTreeSet<ChangeId>,
}

/// The subgraph of open changes relevant to one viewer.
///
/// Closed under `parents`: every parent of a node is itself a node.
pub struct HomeGraph {
    pub nodes: BTreeMap<ChangeId, HomeNode>,
}

impl Cabaret {
    /// Every open change `viewer` owns, plus all open ancestors as unowned context.
    pub fn home_graph(&self, viewer: &Identity) -> Result<HomeGraph> {
        let mut open = BTreeMap::new();
        for id in self.changes()? {
            let change = self.change(&id)?;
            open.insert(id, change);
        }

        let mut include: BTreeSet<&ChangeId> =
            open.iter().filter(|(_, change)| change.owners.contains(viewer)).map(|(id, _)| id).collect();
        let mut frontier: VecDeque<&ChangeId> = include.iter().copied().collect();
        while let Some(id) = frontier.pop_front() {
            for parent in open[id].parents.iter().filter(|parent| open.contains_key(*parent)) {
                if include.insert(parent) {
                    frontier.push_back(parent);
                }
            }
        }

        let nodes = include
            .into_iter()
            .map(|id| {
                let change = &open[id];
                let node = HomeNode {
                    title: change.title.clone(),
                    owned: change.owners.contains(viewer),
                    parents: change.parents.iter().filter(|parent| open.contains_key(*parent)).cloned().collect(),
                };
                (id.clone(), node)
            })
            .collect();
        Ok(HomeGraph { nodes })
    }
}
