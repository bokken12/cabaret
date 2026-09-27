Commit hunks and files from a workspace file diff

On a workspace file diff, `! c` (`cabaret.commitSelected`) commits part of the file under the cursor: the hunk at the cursor, or the changed lines selected on whichever side has focus. `! C` (`cabaret.commitAll`) commits the diff's files whole. On the workspace page both work as before, on the selected files or on everything.

The hunk `! c` would take is highlighted on both sides of the diff as the cursor moves. These are gix's hunks, which can split differently from VS Code's diff shading, so the highlight shows exactly what will be committed. A renamed file has to be committed whole.

After a commit, the diff reopens at the new tip with the cursor where it was. Once a file has nothing left to commit, it moves on to the next uncommitted file, like `! m` does, and after the last one to the workspace page.

The `!` chord is bound on the diff in Vim's Normal and Visual modes. Without Vim it is bound only on the read-only before side, because the after side is the editable file and `!` has to type there.

Tests: `vscode/test/workflows.test.ts` covers committing the hunk at the cursor, then files whole. Workspace paths are now printed relative to the workspace, since the fixture's absolute path changes every run. The highlight itself has not been checked by eye.