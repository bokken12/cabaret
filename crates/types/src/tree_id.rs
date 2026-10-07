use gix::ObjectId;

// TODO-someday(joel): do we need this if it's only used within `cabaret-transaction`? Maybe we could just use
// `gix::Tree<'ctx>` directly instead?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeId(pub ObjectId);

impl From<TreeId> for ObjectId {
    fn from(tree: TreeId) -> Self { tree.0 }
}
