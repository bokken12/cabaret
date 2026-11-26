# Transaction

Most of Cabaret's internal change-state-mutating operations are implemented as "transactions". That is:

- Their effects can be summarized as edits to refs (fast-forwarding a metadata log or branch, updating a workspace, etc) which can all be performed atomically at the end of the transaction (although they may first do some preliminary uncommitted work to prepare these ref edits).
- They may hit against various errors or safeguards in the course of operation, in which case they can abort the entire transaction.
- They should keep a single persistent view of each change's state throughout the transaction.

Note that at the end of the day, rather than being serialized to a single transaction log as the source of truth, the individual refs are treated as decisive. This means that transactions are not truly atomic in the log.

Nonetheless, Cabaret attempts to nudge towards convenient semantics, e.g. locking refs which a transaction edits, so that, at least in the context of a single device, transactions cannot overlap.

Across devices, Cabaret attempts to define its transactions to be resilient to ordinary distributed systems problems: e.g., a change which has already been landed but which receives additional commits may be re-landed into its parent to adopt the new diff.
