use cabaret_types::RevisionId;
use gix::Id;

pub struct Revision<'ctx>(Id<'ctx>);

impl<'ctx> Revision<'ctx> {
    pub fn id(&self) -> RevisionId { RevisionId(self.0.detach()) }
}
