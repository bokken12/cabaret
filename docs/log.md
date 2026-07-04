# Log

The source of truth for each change is its log. The log is append-only, and composed only of associative operations to permit automatic merging via union. Logs are only ever started by `create`, which records a parent, a base, and an owner; a log missing any of these is malformed.

Each log entry consists of

- `timestamp` (unix milliseconds) when the entry was created
- `user` who wrote the entry
- `action` taken by the entry

Where the `action` may be any of (incomplete)

- `set-base` to a commit `base`
- `set-parent` to `ref`
- `set-owner` to a user `owner`, replacing the previous owner

- `review` a `file`, recording the `base` and `tip` of the reviewed diff
    - possibly there should be a mechanism to review all files?
- `forget` a `file`
    - possibly this could be melded into `review`?
- `land` the change, recording the `merge` commit that landed it in the parent; the change is frozen from then on, though review state may still be recorded
- `comment` with `text`

Logs entries written by one version of Cabaret must always be readable by all future versions of Cabaret, and so actions will likely be versioned. We do not make the same guarantee that newer versions always be readable by older versions.