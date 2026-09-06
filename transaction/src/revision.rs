use cabaret_types::RevisionId;
use gix::Commit;

pub struct Revision<'ctx>(Commit<'ctx>);

impl<'ctx> Revision<'ctx> {
    pub fn id(&self) -> RevisionId { RevisionId(self.0.id) }
}
