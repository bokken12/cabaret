Store each change's log as a commit graph folded in causal order.

Each metadata commit now holds only the actions of its own write (actions.jsonl) beside description.md, on the log commits it was written on. Reading walks that graph and folds actions parents-first; commits that did not see each other go in commit-time order, ties by id, so a skewed clock can no longer reorder a write before what it saw. User and time now come from the commit rather than every entry.

A mark also takes the revision it marks as a parent, so the reviewed revision is fetched with the log and kept from GC after its branch goes; the reader tells those apart because the commit's own actions name them.

The per-transaction timestamp filter is gone, with a TODO(joel) on TransactionContext about giving a transaction one consistent view.

Not included: migrating existing refs/cabaret/changes/* logs, which this build refuses to read (no actions.jsonl).

TODO(joel): docs/log.md and docs/state.md still describe log.jsonl with per-entry timestamps and last-write-wins.