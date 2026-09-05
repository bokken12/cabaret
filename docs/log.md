# Log

The source of truth for each change is its log. The log is append-only, and permits automatic merging. Logs are stored at `refs/cabaret/changes/<name>` in the file named `log.jsonl`.

Each log entry consists of

- `timestamp` when the entry was created
- `user` who wrote the entry
- possibly a future source to map onto forge actions?
- `action` taken by the entry

Where the `action` may be any of (incomplete)

- `add-parent` change
- `remove-parent` change
- `add-owner` user
- `remove-owner` user
- `mark` file as reviewed at revision

Logs entries written by one version of Cabaret must always be readable by all future versions of Cabaret, and so actions will likely be versioned. We do not make the same guarantee that newer versions always be readable by older versions.
