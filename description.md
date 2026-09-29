Landing records the landed change in its parent's log: a `land` action naming the change and
its log head as it stood when landed, which the parent's log commit takes as a git parent. The
landed change's log (title, description, owners, review) stays reachable, and so fetched and
kept, for as long as the parent's log is, even after the change's own refs are deleted.

The referenced log is the one read at the start of the land, so it excludes the `set-archived`
the same land writes; a plain git branch with no log records `"log": null`.

TODO(joel): document the `land` action in docs/log.md.
