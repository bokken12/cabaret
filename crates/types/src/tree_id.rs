use gix::ObjectId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeId(pub ObjectId);

impl From<TreeId> for ObjectId {
    fn from(tree: TreeId) -> Self { tree.0 }
}
