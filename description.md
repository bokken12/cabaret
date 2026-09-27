Offer committing a hunk from the lightbulb

On a workspace file diff, the lightbulb offers "Commit hunk to <change>" when the cursor is in a hunk, or "Commit selected lines to <change>" when the selection touches one. Either runs `! c` (`cabaret.commitSelected`), so it commits exactly the highlighted hunk or the selection.

Tested in `vscode/test/workflows.test.ts` through `vscode.executeCodeActionProvider`. I haven't checked that the lightbulb itself appears for an action with no kind.