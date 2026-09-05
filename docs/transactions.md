# Transaction

Most of Cabaret's internal change-state-mutating operations are implemented as "transactions". These give some nice properties:

- They lock any changes undergoing mutation so that the mutating in-memory representation can be treated as the source of truth throughout the operation until it has been written.
- They keep a single persistent view of each change's state during the transaction, making them a pure function of change state.
- They prevent the implementations from having to think in terms of log actions and manually check things like avoiding no-op actions.
- They guarantee that the operation is atomic and will not be partially completed.

Certainly the locking here is of limited power in a distributed system: a different device may execute an unrelated transaction simultaneous to yours. Additionally, the file operations when updating a workspace cannot be fully atomic. Cabaret tries to define its operations to be well-behaving in the face of this: e.g., committing to an already-landed change is allowed and the change can be re-landed to pick up the new changes. Likewise, the parent set is dynamically computed to make sense in the face of archiving and similar. Nonetheless, this provides some nice properties on a single device.
