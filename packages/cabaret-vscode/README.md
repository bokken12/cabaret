# cabaret-vscode

Cabaret's pages as read-only text buffers in VS Code. Each page is a virtual
document on the `cabaret:` URI scheme, rendered by the shared views in
`cabaret-views` and queried through `GitBackend` in the extension host — real
text buffers, so search, selection, and vim keybindings work untouched.

## Commands

- **Cabaret: Todo** — open the todo page: what awaits your attention.
- **Cabaret: Show Change** — open the current change's show page, picking
  one when no change is current.
- In a cabaret buffer, `enter` opens the target under the cursor, `tab`
  folds or unfolds the section at the cursor, and `R` re-renders the page.
  On a show page, `r` opens the change's review page,
  `^` climbs to the parent's show page — or to the todo page from a change
  rooted on a trunk — and `$` descends to a child's, picking one when there
  are several. On the review page, `enter` opens the first file left to
  review unless the cursor is on another file's line.
- Change actions sit behind `!` chords: `!c` creates a child, `!p` splices in
  a parent, `!o` sets the owner, `!rb` rebases, `!rn` renames, `!rp`
  reparents, and `!la` lands.
- Forge sync follows magit: `F` pulls from the forge, `P` pushes the change
  under the cursor (or the shown change) to it.
- With VSCodeVim, the bindings apply in normal and visual mode and stay out
  of the way while vim is reading input, so search and motions work as usual.
  One exception needs a hand: a user-level `extension.vim_tab` binding (as in
  VSCodeVim's own setup instructions) outranks the extension's `tab`, so add
  `&& resourceScheme != 'cabaret'` to its `when` clause, as edamagit does
  with `editorLangId != 'magit'`.
- With [leaderkey](https://github.com/JimmyZJX/leaderkey) installed, `SPC a f
  t` opens the todo page and `SPC a f s` shows the current change.

## Installing

Build, package, and install into VS Code in one step:

```sh
packages/cabaret-vscode/install.sh
```

Then reload any open VS Code windows.

## Developing

Launch the extension host with the "Run cabaret-vscode" configuration (F5),
which builds the bundle first; `pnpm --filter cabaret-vscode build` does the
same build by hand. In the development host window, open a repository with
cabaret changes and run "Cabaret: Todo" from the command palette.
