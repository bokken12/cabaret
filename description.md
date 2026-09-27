Offer committing a hunk from a hover, not the lightbulb

VS Code runs no code actions in read-only editors (`codeActionModel.ts` requires `!readOnly`). Since the workspace diff became read-only, the lightbulb from the change below could never appear. Its test called `vscode.executeCodeActionProvider` directly, which skips that check, so it still passed.

A hover replaces it. On the side of a workspace file diff that holds the cursor, hovering the highlighted hunk shows "Commit hunk to <change>", and hovering a selected line shows "Commit selected lines to <change>". Either is a link to `! c` (`cabaret.commitSelected`). The text is not styled as a link; only the popup has one. Hover providers are not gated on read-only; the only read-only check in VS Code's hover code hides quick-fix links in diagnostic hovers.

The hover is offered only on the side holding the cursor. `! c` reads the active editor's cursor, and clicking a link in the other side's hover might move focus there.

Tested in `vscode/test/workflows.test.ts` through `vscode.executeHoverProvider`.