# Log

The source of truth for each change is its log. The log is append-only, and composed only of associative operations to permit automatic merging via union. Logs are only ever started by `create`, which records a parent, a base, and an owner; a log missing any of these is malformed.

Each log entry consists of

- `timestamp` (unix milliseconds) when the entry was created
- `user` who wrote the entry
- `source` (optional) the forge state the entry mirrors — an import, or an observation a push records. An entry with a source did not originate locally, and syncing compares the forge against the last source-bearing entry, never against local intent. Its `forge` names the forge; its optional `id` names the forge-side object the entry is a version of (a comment, say), so imports of one object recognize each other.
- `action` taken by the entry

Where the `action` may be any of (incomplete)

- `set-base` to a commit `base`
- `set-parent` to `ref`
- `set-owner` to a user `owner`, replacing the previous owner
- `set-reviewing` to one of `none`, `owner`, `reviewers`, `everyone`: who is asked to review right now (see `reviewing.md`); a log that never set one reads as `everyone`
- `set-archived` to a boolean `archived`: whether the change is set aside as not landing; a log that never set one reads as live. Nothing else moves — the branch and log stay, todos stop asking after the change, and `land` refuses it. Syncing mirrors it to the forge change's open/closed state in both directions.
- `add-reviewer` / `remove-reviewer` a user `reviewer`; per user, the latest entry decides membership, and a reviewer owes review of the change's whole diff

- `review` a `file`, recording the `base` and `tip` of the reviewed diff
    - possibly there should be a mechanism to review all files?
- `forget` a `file`
    - possibly this could be melded into `review`?
- `land` the change, recording the `merge` commit that landed it in the parent; the change is frozen from then on, though review state may still be recorded
- `comment` with `text`; an optional `edits` names the hash of the entry it supersedes, so versions of one comment display as the latest

Logs entries written by one version of Cabaret must always be readable by all future versions of Cabaret, and so actions will likely be versioned. We do not make the same guarantee that newer versions always be readable by older versions.