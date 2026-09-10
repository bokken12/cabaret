cabaret-vscode should have a "create workspace" command and keybinding (! w c).

Implementation: Relabel the existing Add Workspace command as Create Workspace and bind it to ! w c instead of ! w a. Keep the cabaret.addWorkspace command ID so existing callers continue to work; its action already creates a workspace for the selected change.

Validation: TypeScript typecheck, oxlint, JSON parsing, and whitespace checks pass. Verified the command title and unique ! w c binding. The package formatter reports an existing issue also present on main. Interactive VS Code was not exercised.