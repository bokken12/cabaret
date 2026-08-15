# Frontends

Cabaret hopes to support a number of different front-end interfaces for interaction, including but not limited to (in approximate order of priority):

- CLI
- VSCode Extension
- Web
- Zed Extension
- TUI

This raises a lot of questions for how exactly they should be architected to share the same look and feel.

For the time being however, I believe the best path is not to consider this. They can share the same logical core, but each one can develop its UI fairly independently to what is available for it.

Ideally any keybindings and approximate flows should be similar between formats, and If sufficient common patterns emerge we may be able to extract these out at the time, but not prematurely.
