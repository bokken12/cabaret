Currently, a feature's description is included in its log, via `set-description` entries.

This last-writer-wins semantics is not great for distributed collaboration, especially when we're built on top of git which provides better primitives.

Move the description out of the log file and into an adjacent file (say `description.md`). Writes to the description are now commits with edits to that file rather than commits with a log append. Cabaret refs must always be auto-merged, and so the descrption files will be merged by accepting and committing the conflicted version (where log files are auto-merged by union).