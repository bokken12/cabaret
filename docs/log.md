# Log

The source of truth for each change is its log. The log is append-only, and composed only of associative operations to permit automatic merging via union.

Each log entry consists of

- `timestamp` (unix milliseconds) when the entry was created
- `user` who wrote the entry
- `action` taken by the entry

Where the `action` may be any of (incomplete)

- `set-base` to a commit `base`
- `set-parent` to `ref`
- `set-owner` to a user `owner`
    - a change has exactly one owner (the `set-owner` with the greatest timestamp), so transferring ownership replaces the previous owner

- `review` a `file`, recording the `base` and `tip` of the reviewed diff
    - possibly there should be a mechanism to review all files?
- `forget` a `file`
    - possibly this could be melded into `review`?
- `comment` with `data`

Logs entries written by one version of Cabaret must always be readable by all future versions of Cabaret, and so actions will likely be versioned. We do not make the same guarantee that newer versions always be readable by older versions.