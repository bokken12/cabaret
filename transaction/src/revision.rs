use cabaret_types::{Result, RevisionId};
use gix::Commit;

// TODO(joel): consider using wrapper types like this
#[derive(Debug, Clone)]
pub struct Revision<'ctx>(pub Commit<'ctx>);

impl<'ctx> Revision<'ctx> {
    pub fn id(&self) -> RevisionId { RevisionId(self.0.id) }

    pub fn is_predecessor(&self, successor: &Revision<'ctx>) -> Result<bool> {
        Ok(self.0.repo.merge_base(self.id(), successor.id())?.detach() == self.0.id)
    }

    pub fn is_successor(&self, predecessor: &Revision<'ctx>) -> Result<bool> { predecessor.is_predecessor(self) }
}
