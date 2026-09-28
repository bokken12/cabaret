Offer committing from the right-click menu, not the lightbulb

VS Code runs no code actions in read-only editors (`codeActionModel.ts` requires `!readOnly`). Since the workspace diff became read-only, the lightbulb from the change below could never appear. Its test called `vscode.executeCodeActionProvider` directly, which skips that check, so it still passed. The lightbulb is removed.

Right-clicking a workspace file diff now offers "Cabaret: Commit Hunk" (no selection) or "Cabaret: Commit Selected Lines" (with one), and "Cabaret: Commit File". The first two run what `! c` does, and the third what `! C` does on a file diff. A menu entry shows its command's own title, so these are commands of their own, hidden from the command palette where they would duplicate `! c`/`! C`. Right-clicking outside the selection moves the cursor there first, so the hunk highlighted is the one committed.

The change is named `commit-hunk-hover` because it first offered the commit as a hover link. We dropped that: a hover pops up uninvited while you read, and VS Code puts range actions like git's "Stage Selected Ranges" in the right-click menu.

Tested in `vscode/test/workflows.test.ts` by running the menu's commands; the menu entries themselves are not tested.