Commit one hunk of a file's workspace diff

`Cabaret::commit_hunk` commits one hunk of a file's diff from the change's tip to what its workspace has on disk. The rest stays uncommitted. `Cabaret::workspace_hunks` lists the hunks for a frontend to choose from. Both are exposed over napi for the VS Code extension.

`Hunk` and `LineRange` are value types in `cabaret-types`. `Hunk::between` computes a file's hunks with gix's line diff (imara Histogram with git's slider heuristics), so they can split differently from VS Code's own diff. `Hunk::apply` splices one hunk into the before version, and returns `None` if it isn't a hunk of that diff.

`commit_hunk` takes the tip the diff was drawn from, and refuses if the change has moved on, since the line numbers would then refer to different content. It also refuses a hunk the current diff no longer has. A deleted file or a symlink has to be committed whole. After the commit, the index is set to the committed tree with that file's stat data cleared, so git rehashes it and still shows the rest of the file as uncommitted.

Committing only part of a hunk, such as a selection's lines, is left for later.