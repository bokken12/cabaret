# Keybindings

How we choose keys across the interactive hosts. VS Code is the only host
with bindings today; the web app and any future TUI should draw from the same
key vocabulary so that moving between hosts costs nothing.

## Principles

### Don't fight vim navigation

Cabaret pages are ordinary read-only text buffers precisely so that a user's
editor habits — most commonly vscode-vim, installed unmodified — keep working.
Vim's motion and search keys are therefore reserved: we never bind them, and a
page should be fully navigable with them alone.

Reserved outright: `h j k l`, word motions (`w b e`), `gg` / `G`,
scrolling (`ctrl+d` `ctrl+u` `ctrl+f` `ctrl+b`), search (`/` `?` `n` `N`),
visual mode (`v` `V`), yank (`y`), marks.

Vim keys whose meaning has little value in a cabaret buffer are fair to
reclaim. Targets resolve per line, so column motions `^` and `$` buy nothing;
`r`, `R`, and `!` edit text, which a read-only buffer can't; `enter` is nearly
`j0`. Each reclaimed key should earn its keep — when in doubt, leave it to vim.

All bindings are gated on cabaret buffers and, when vim is active, on
normal/visual mode, so insert-mode text entry (in future writable surfaces)
is never shadowed.

### One meaning per key

A key means the same thing on every page, and a letter means the same thing
everywhere it appears inside a chord. Users should be able to guess a binding
they've never been told from ones they know. When a key can't act on some page
it should do nothing there, not something else.

### Spend the key budget by frequency

Bare keys are the prime real estate; they go to the actions performed dozens
of times per session (navigation, stepping through a review). Chord length
scales with rarity and consequence: the per-file "mark reviewed" is two
keystrokes, while landing a change — rare and hard to undo — takes three.
Friction on consequential actions is a feature.

### Reads are bare, writes are namespaced

Anything that mutates state lives behind the `!` prefix. A bare key can be
pressed experimentally without fear; a `!` chord means you asked for a side
effect. This also keeps the bare-key budget for navigation.

## Core vocabulary

The keys every page shares. Pages nest — home → show → review → diff → source
location — and separately what a page shows has siblings: a change sits in a
parent/child tree, a diff's file in its round's list. The two axes get
distinct keys.

| Key     | Meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| `enter` | step inside: open the target under the cursor, one page level deeper |
| `esc`   | step outside: back out one page level                                 |
| `^`     | step up: the sibling above — a change's parent, a diff's previous file |
| `$`     | step down: the sibling below — a change's child, a diff's next file   |
| `!`     | prefix for state-mutating actions                                     |
| `tab`   | toggle the thing under the cursor (folding and the like)              |
| `R`     | refresh the page                                                      |

The vim mnemonics carry over sideways: `^` and `$` move toward the "start"
and "end" of the sibling axis the way they move within a line.

## Current bindings

The binding table is generated from the extension manifest into
[`packages/cabaret-vscode/keybindings-reference.md`](../packages/cabaret-vscode/keybindings-reference.md),
and `?` on any cabaret page lists the bindings that apply there.

## Divergences and open questions

Where the current bindings fall short of the principles:

- **`tab` only folds headed sections.** Diff hunks don't fold yet, though
  they are the other natural thing under the cursor for `tab` to toggle.
- **`r` (review) is bare but arguably a sibling of `enter`.** It navigates —
  opens the review page — so bare is right; but it's show-page-only, where
  one-meaning would have it work on any page with a current change.
- **`F` and `S` are bare writes.** Fetch and sync mutate state but sit
  outside the `!` namespace — `F` borrowed whole from magit, `S` following
  its lead — and the muscle memory is worth more than the rule. Both keys
  clear the vim bar: `F` is a column motion and `S` edits text, neither of
  which buys anything in a read-only buffer.
- **Page gates are inconsistent across the `!` family.** Land and
  create-child/parent work everywhere, mark-reviewed only on review and diff
  pages, and the rest of the chords everywhere but the diff pages. Pick one
  rule — probably "mutations that take the current change work anywhere one
  is shown" — and apply it uniformly.
