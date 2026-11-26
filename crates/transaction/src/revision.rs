use cabaret_types::{Result, RevisionId};
use gix::Commit;

// TODO(joel): consider using wrapper types like this
#[derive(Debug, Clone)]
pub struct Revision<'txn>(pub Commit<'txn>);

impl<'txn> Revision<'txn> {
    pub fn id(&self) -> RevisionId { RevisionId(self.0.id) }

    pub fn is_predecessor(&self, successor: &Revision<'txn>) -> Result<bool> {
        Ok(self.0.repo().merge_base(self.id(), successor.id())?.is_some_and(|base| base == self.0.id))
    }

    pub fn is_successor(&self, predecessor: &Revision<'txn>) -> Result<bool> { predecessor.is_predecessor(self) }
}
