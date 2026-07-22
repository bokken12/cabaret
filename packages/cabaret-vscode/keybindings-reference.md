# Cabaret VS Code Keybindings

<!-- Generated from the extension manifest; do not edit by hand. Regenerate with `pnpm test -u`. -->

The bindings contributed by `cabaret-vscode`, in manifest order. Keys are
written as the character typed (`!` is `shift+1`, `^` is `shift+6`); a
multi-key chord is consecutive keystrokes. `?` on any cabaret page lists
the bindings that apply there. `docs/keybindings.md` explains how keys
are chosen.

| Keys    | Action                | Pages                     |
| ------- | --------------------- | ------------------------- |
| `enter` | Open Target at Cursor | all                       |
| `esc`   | Step Outside          | show, review, diffs, diff |
| `tab`   | Toggle Fold           | all                       |
| `q`     | Close Page            | all                       |
| `R`     | Refresh               | all                       |
| `?`     | Keybindings           | all                       |
| `r`     | Review                | show                      |
| `d`     | Review Diffs          | show, review              |
| `@`     | Act as User           | all                       |
| `! m`   | Mark Reviewed         | diff, review              |
| `^`     | Step Up               | show, diff                |
| `$`     | Step Down             | show, diff                |
| `! r b` | Rebase                | home, show, review        |
| `! l`   | Land                  | all                       |
| `! r p` | Reparent              | home, show, review        |
| `! o`   | Set Owner             | home, show, review        |
| `! v`   | Widen Reviewing       | home, show, review        |
| `! d`   | Disable Reviewing     | home, show, review        |
| `! a`   | Toggle Archived       | home, show, review        |
| `! g`   | Go to Workspace       | home, show, review        |
| `! w a` | Add Workspace         | home, show, review        |
| `! w d` | Remove Workspace      | home, show, review        |
| `! w r` | Reclaim Workspaces    | home                      |
| `! c`   | Create Child          | all                       |
| `! p`   | Create Parent         | all                       |
| `F`     | Fetch Remote Activity | all                       |
| `S`     | Sync Change           | all                       |
