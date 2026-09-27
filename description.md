Commit part of a file's workspace diff

`Cabaret::commit_part` commits one hunk, or the changed lines a selection covers on either side, of a file's diff from the change's tip to what its workspace has on disk. The rest stays uncommitted. `Cabaret::workspace_hunks` lists the hunks, so a frontend can show which one a command would take. Both are exposed over napi for the VS Code extension.

Hunks come from gix's line diff (imara Histogram with git's slider heuristics), so they can split differently from VS Code's own diff. How a selection picks lines is documented on `Pick::Lines`. When a hunk has the same number of lines on each side, picked lines pair up with their counterparts. Otherwise lines picked on one side take all of the other side's lines, which is also how VS Code's git "stage selected ranges" works.

`commit_part` takes the tip the diff was drawn from, and refuses if the change has moved on, since the line numbers would then refer to different content. A deleted file or a symlink has to be committed whole. After a partial commit, the index is set to the committed tree with that file's stat data cleared, so git rehashes it and still shows the rest of the file as uncommitted.
