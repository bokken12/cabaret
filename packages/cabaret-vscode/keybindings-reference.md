# Cabaret VS Code Keybindings

<!-- Generated from the extension manifest; do not edit by hand. Regenerate with `pnpm test -u`. -->

The bindings contributed by `cabaret-vscode`, in manifest order. Keys are
written as the character typed (`!` is `shift+1`, `^` is `shift+6`); a
multi-key chord is consecutive keystrokes. `?` on any cabaret page lists
the bindings that apply there. `docs/keybindings.md` explains how keys
are chosen.

| Keys    | Action                | Pages              |
| ------- | --------------------- | ------------------ |
| `enter` | Open Target at Cursor | all                |
| `tab`   | Toggle Fold           | all                |
| `q`     | Close Page            | all                |
| `R`     | Refresh               | all                |
| `?`     | Keybindings           | all                |
| `r`     | Review                | show               |
| `d`     | Review Diffs          | show, review       |
| `@`     | Act as User           | all                |
| `! m`   | Mark Reviewed         | diff, review       |
| `^`     | Show Parent           | show               |
| `$`     | Show Child            | show               |
| `! r b` | Rebase                | todo, show, review |
| `! l a` | Land                  | all                |
| `! r n` | Rename                | todo, show, review |
| `! r p` | Reparent              | todo, show, review |
| `! o`   | Set Owner             | todo, show, review |
| `! v`   | Widen Reviewing       | todo, show, review |
| `! d`   | Disable Reviewing     | todo, show, review |
| `! g`   | Go to Workspace       | todo, show, review |
| `! w a` | Add Workspace         | todo, show, review |
| `! w d` | Remove Workspace      | todo, show, review |
| `! c`   | Create Child          | all                |
| `! p`   | Create Parent         | all                |
| `F`     | Fetch Remote Activity | all                |
| `S`     | Sync Change           | all                |
