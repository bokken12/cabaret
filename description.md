Offer committing a hunk from the lightbulb

On a workspace file diff, the lightbulb offers "Commit hunk to <change>" when the cursor is in a hunk, or "Commit selected lines to <change>" when the selection touches one. Either runs `! c` (`cabaret.commitSelected`), so it commits exactly the highlighted hunk or the selection.

The action has no kind. VS Code's automatic lightbulb trigger applies no kind filter and only drops `source.*` actions, so it still gets a lightbulb.

Tested in `vscode/test/workflows.test.ts` through `vscode.executeCodeActionProvider`.