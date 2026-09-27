Show a workspace diff's after side read-only, as saved

The after side of a workspace file diff used to be the file itself, editable and live. It is now a read-only `cabaret-blob` holding the file as saved when the diff was opened, like every other side of every diff. Enter still opens the real file at the cursor's line for editing. Each opening reads the file afresh, so reopening a diff, or the reopen after a commit, shows the latest save.

This means Cabaret's single-key bindings (`q`, Enter, `^`, `$`, `!`) never land on an editable buffer. That fixes the case where, without Vim, typing `q` or Enter on a workspace diff's after side closed the tab or jumped to the file. `! c`/`! C` on file diffs drop their `editorReadonly` special case.

Since the saved file can change while the diff is open, hunks are now computed from the two texts on screen (a napi `hunks(before, after)`), and `Cabaret::commit_part` takes the after text that was shown and refuses if the file on disk no longer matches it. `Cabaret::workspace_hunks` is replaced by `Cabaret::workspace_file`, which serves the after side as git would store it, so the diff shows exactly what a commit records.

Language features that only serve `file:` documents (hovers, go to definition, diagnostics) are gone from the after side, matching the committed views.