Currently, a feature's description is included in its log, via `set-description` entries.

This last-writer-wins semantics is not great for distributed collaboration, especially when we're built on top of git which provides better primitives.

Move the description out of the log file and into an adjacent file (say `description.md`). Writes to the description are now commits with edits to that file rather than commits with a log append. Cabaret refs must always be auto-merged, and so the descrption files will be merged by accepting and committing the conflicted version (where log files are auto-merged by union).

## Notes

- `description.md` is always written, empty when there is no description, so clearing a description that an older log had set still takes effect.
- `set-description` stays in `LogAction` so older logs still parse; it folds only until a `description.md` exists, and the next write of any kind moves the description into the file.
- Merging cabaret refs (log union, description conflicts kept) has no caller yet since `fetch` is unimplemented; it belongs with that work.

TODO(human): update `docs/log.md` for the metadata commit now holding `description.md` beside `log.jsonl`.
