# cabaret-vscode

Cabaret's pages as read-only text buffers in VS Code. Each page is a virtual
document on the `cabaret:` URI scheme, rendered by the shared views in
`cabaret-views` and queried through `GitBackend` in the extension host — real
text buffers, so search, selection, and vim keybindings work untouched.

## Commands

- **Cabaret: Todo** — open the todo page: what awaits your attention.
- **Cabaret: Show Change** — open the current change's show page, picking
  one when no change is current.
- In a cabaret buffer, `enter` opens the target under the cursor, `esc`
  steps outside to the enclosing page — a file's diff to the review page,
  the review page to the show page, the show page to home — `tab`
  folds or unfolds the section at the cursor, `R` re-renders the page,
  `q` closes it, and `?` lists the page's keybindings — picking an entry
  runs it.
  On a show page, `r` opens the change's review page.
  `^` and `$` step up and down between siblings: from a change's pages to
  the parent's or a child's page of the same kind — picking a child when
  there are several — and from a file's diff to the round's previous or
  next file. On the review page, `enter` opens the first file left to
  review unless the cursor is on another file's line.
- Change actions sit behind `!` chords: `!c` creates a child, `!m` marks a
  file reviewed, `!la` lands, and so on.
- Remote traffic follows magit's `F`: `F` fetches remote activity, and `S`
  syncs the change under the cursor (or the shown change) with origin.
- The full binding table lives in
  [`keybindings-reference.md`](./keybindings-reference.md), generated from
  this extension's manifest.
- **Cabaret: Apply Recommended Git Settings** — apply the git configuration
  Cabaret recommends: zdiff3 conflict markers, rerere, and fetching change
  logs with every `git fetch` (the same set as `cabaret setup apply`). The
  extension offers these on its own the first time it runs, once per scope:
  declining records `cabaret.setupDeclined` in the matching git config and
  keeps the offer quiet from then on.
- With VSCodeVim, the bindings apply in normal and visual mode and stay out
  of the way while vim is reading input, so search and motions work as usual.
  `tab` and `esc` need a hand; see below.
- With [leaderkey](https://github.com/JimmyZJX/leaderkey) installed, `SPC a f
  t` opens the todo page and `SPC a f s` shows the current change.

## VSCodeVim, tab, and esc

VSCodeVim also binds `tab` and `esc` at the extension level, and when two
extensions claim a key, which one wins is a load-ordering accident. The
deterministic arrangement — the same one edamagit's setup uses — is to take
the bindings over in your own keybindings.json, since user bindings outrank
every extension, and carve out the buffers that want each key for
themselves. `tab` is ceded in every cabaret buffer; `esc` only in normal
mode, where vim's own `esc` has nothing left to cancel — vim must keep it
in the other modes, or visual mode would have no way out:

```jsonc
{
  "key": "tab",
  "command": "-extension.vim_tab"
},
{
  "key": "tab",
  "command": "extension.vim_tab",
  "when": "editorTextFocus && vim.active && !inDebugRepl && vim.mode != 'Insert' && resourceScheme != 'cabaret'"
},
{
  "key": "escape",
  "command": "-extension.vim_escape"
},
{
  "key": "escape",
  "command": "extension.vim_escape",
  "when": "editorTextFocus && vim.active && !inDebugRepl && (resourceScheme != 'cabaret' || vim.mode != 'Normal')"
}
```

If you already carry the `tab` pair from edamagit's instructions, keep its
`editorLangId != 'magit'` exclusion alongside and just add
`&& resourceScheme != 'cabaret'` to the `when`.

Without VSCodeVim no entries are needed: `esc`'s binding already yields to
the editor's dismissals — closing the find widget, clearing a selection or
extra cursors — and steps outside only once there is nothing left to
dismiss.

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
