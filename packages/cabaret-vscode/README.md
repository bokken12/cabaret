# cabaret-vscode

Cabaret's pages as read-only text buffers in VS Code. Each page is a virtual
document on the `cabaret:` URI scheme, rendered by the shared views in
`cabaret-views` and queried through `GitBackend` in the extension host — real
text buffers, so search, selection, and vim keybindings work untouched.

## Commands

- **Cabaret: Todo** — open the todo page: what awaits your attention.
- **Cabaret: Show Change** — pick a change and open its show page.
- In a cabaret buffer, `enter` opens the target under the cursor and `r`
  re-renders the page.

## Installing

Package the built bundle and install it into VS Code:

```sh
pnpm --filter cabaret-vscode build
cd packages/cabaret-vscode
pnpm dlx @vscode/vsce package --no-dependencies -o cabaret-vscode.vsix
code --install-extension cabaret-vscode.vsix
```

## Developing

Launch the extension host with the "Run cabaret-vscode" configuration (F5),
which builds the bundle first; `pnpm --filter cabaret-vscode build` does the
same build by hand. In the development host window, open a repository with
cabaret changes and run "Cabaret: Todo" from the command palette.
