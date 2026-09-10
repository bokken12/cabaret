Use Create Workspace and Delete Workspace in VS Code

Expose workspace creation as cabaret.createWorkspace with ! w c, and deletion as cabaret.deleteWorkspace with ! w d. Update command-palette titles, registrations, keybindings, and success messages to use create/delete terminology.

The old cabaret.addWorkspace and cabaret.removeWorkspace command IDs are replaced, so custom bindings referencing them must use the new IDs.

Validation: TypeScript typecheck, oxlint, source formatting, and whitespace checks pass. Verified both command IDs, titles, registrations, and bindings agree and that no old command IDs remain in the extension source or manifest. The package formatter has an existing issue also present on main. Interactive VS Code was not exercised.