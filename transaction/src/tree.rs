use cabaret_types::TreeId;
use gix::Tree as GixTree;

// TODO(joel): internal name?
pub struct Tree<'ctx>(GixTree<'ctx>);

impl<'ctx> Tree<'ctx> {
    pub fn id(&self) -> TreeId { TreeId(self.0.id) }
}
