use cabaret_types::TreeId;
use gix::Id;

pub struct Tree<'ctx>(Id<'ctx>);

impl<'ctx> Tree<'ctx> {
    pub fn id(&self) -> TreeId { TreeId(self.0.detach()) }
}
