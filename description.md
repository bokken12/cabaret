Name changes by title

A change is shown by its title wherever it is named, falling back to its id when untitled:
home rows, the change page's heading, and in VS Code every message and prompt. The id stays
reachable where it matters: the change page gets an `Id:` line, and VS Code's change pickers
dim it beside each title so changes titled alike can be told apart.

Pointers out stay ids, since they should be unique: the change page's parents, CLI
arguments, and the CLI's one-line results, which name what gets typed next. VS Code tab
labels still come from page URIs, which are keyed by id.