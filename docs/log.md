# Log

The source of truth for each change is its log. The log is append-only, and permits automatic merging. Logs are stored at `refs/cabaret/changes/<name>` as a graph of commits: each write is one commit holding its own actions in the file named `actions.jsonl`, whose parents are the log commits it had seen. Reading folds every commit's actions in the order this graph implies, with writes that did not see each other ordered by commit time.

Each log commit consists of

- its author and time, as the commit's own
- possibly a future source to map onto forge actions?
- the `action`s it took, one per line

Where the `action` may be any of (incomplete)

- `add-parent` change
- `remove-parent` change
- `add-owner` user
- `remove-owner` user
- `mark` file as reviewed at revision, whose commit also takes that revision as a parent so it is fetched and kept along with the log

## Syncing

`cab fetch` exchanges logs with origin in both directions. Origin's logs are fetched to `refs/cabaret/remotes/origin/changes/<name>`, which sits outside `refs/remotes/origin/` so that no branch name can collide with them. Each one is merged into the local log, and then every local log is pushed back. Pushes are never forced, so a push that loses a race is rejected, and the next fetch merges it in.

A merge fast-forwards when one log has already seen the other. Otherwise it writes a merge commit on both heads. The merge commit takes no actions of its own, since folding already orders both sides. Its description is the two sides' descriptions merged 3-way from the latest commit both had seen, with any conflict kept as text.

## Compatibility

Logs entries written by one version of Cabaret must always be readable by all future versions of Cabaret, and so actions will likely be versioned. We do not make the same guarantee that newer versions always be readable by older versions.
