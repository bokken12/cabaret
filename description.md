Show changes by title

The title is a change's primary visual indicator and the id its unique identifier. Home rows
and the change page's heading show the title, falling back to the id when untitled, and the
change page gets an `Id:` line. VS Code's change pickers list titles with the id dimmed
beside each, so changes titled alike can be told apart.

Everything that points at a change keeps its id: the change page's parents, CLI arguments
and results, and VS Code's messages, prompts, picker titles and tab labels.