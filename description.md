Prototype: transactions read committed state and write through write-only handles.

A transaction's closure gets one `MetadataEdit` per declared metadata, to push log actions and a description onto, and one `Option<RevisionId>` per declared branch, to set a tip in. Everything read through the transaction is as committed; a proposed tip or parent set is a local value. `Metadata::actions_since` and the in-flight clones go, `BranchOp::Insert` no longer carries a tip, and `create` and `create_parent` build their tips under the lock.

Workspace handles are unchanged.