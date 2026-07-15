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

The keys every page shares. Pages nest — todo → show → review → diff → source
location — and separately each change sits in a parent/child tree; the two
axes get distinct keys.

| Key     | Meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| `enter` | step inside: open the target under the cursor, one page level deeper |
| `esc`   | step outside: back out one page level                                 |
| `^`     | go up the change tree: the parent change                              |
| `$`     | go down the change tree: a child change                               |
| `!`     | prefix for state-mutating actions                                     |
| `tab`   | toggle the thing under the cursor (folding and the like)              |
| `R`     | refresh the page                                                      |

The vim mnemonics carry over sideways: `^` and `$` move to the "start" and
"end" of the change's lineage the way they move within a line.

## Current bindings

VS Code, from `packages/cabaret-vscode/package.json`. Keys are written as the
character typed (`!` is `shift+1`, `^` is `shift+6`, `$` is `shift+4`).

| Keys    | Action                                          | Pages        |
| ------- | ----------------------------------------------- | ------------ |
| `enter` | open the target under the cursor                | all          |
| `tab`   | toggle folding of the section at the cursor     | all          |
| `R`     | refresh                                         | all          |
| `r`     | review: open the change's review page           | show         |
| `^`     | show parent                                     | show         |
| `$`     | show child                                      | show         |
| `! r`   | mark file reviewed, advance to the next         | diff         |
| `! c`   | create child                                    | all          |
| `! p`   | create parent                                   | all          |
| `! i`   | import forge change                             | todo, show   |
| `F`     | pull from the forge                             | all          |
| `P`     | push the change to the forge                    | all          |
| `! l a` | land                                            | all          |
| `! o`   | set owner                                       | all but diff |
| `! v`   | widen reviewing                                 | all but diff |
| `! d`   | disable reviewing (set it to none)              | all but diff |
| `! r n` | rename                                          | all but diff |
| `! r p` | reparent                                        | all but diff |
| `! r b` | rebase                                          | all but diff |

## Divergences and open questions

Where the current table falls short of the principles:

- **`esc` is unbound.** Step-outside doesn't exist yet. `esc` needs care: VS
  Code uses it to dismiss find widgets, extra cursors, and peek views, and
  vim users hit it reflexively to cancel pending input — a step-outside
  binding must not swallow those.
- **`tab` only folds headed sections.** Diff hunks don't fold yet, though
  they are the other natural thing under the cursor for `tab` to toggle.
- **`! r` is both a chord and a prefix.** On diff pages it marks the file
  reviewed; elsewhere it prefixes rebase / rename / reparent. The page gating
  disambiguates for the machine but not for the user's model — the letter `r`
  carries four meanings, and the collision is why the `! r *` family is
  locked out of diff pages at all. Likely fix: move rebase / rename /
  reparent to letters of their own, keeping the short `! r` for the
  high-frequency mark-reviewed.
- **`^` / `$` only work on show pages.** One-meaning says they should work on
  any page with a current change (review, diff), landing on the relative's
  show page.
- **`r` (review) is bare but arguably a sibling of `enter`.** It navigates —
  opens the review page — so bare is right; but it's show-page-only, and the
  same guessability argument as `^` / `$` applies.
- **`F` and `P` are bare writes.** Pull and push mutate state but sit outside
  the `!` namespace, borrowed whole from magit — the muscle memory is worth
  more than the rule. Both keys clear the vim bar: `F` is a column motion and
  `P` pastes, neither of which buys anything in a read-only buffer.
- **Page gates are inconsistent across the `!` family.** Land, pull, and push
  work everywhere, set-owner excludes diff pages, import is todo/show only — and
  only some of these gates trace back to the `! r` collision. Pick one rule —
  probably "mutations that take the current change work anywhere one is
  shown" — and apply it uniformly.
