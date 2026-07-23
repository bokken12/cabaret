# Architecture

Notes on code structure

## Interfaces

A few common interfaces mark seams in Cabaret

### Backend

The "backend" provides primitives to work with the underlying VCS. This is primarily `git` through its CLI, but in the future it could also be `hg` or `jj`, or could be accessed via API on `cabaret-web`.

## Forge

The "forge" is another source of changes (pull requests, merge requests, or similar) which must be synced with for collaboration. This is primarily GitHub, but may also be GitLab, Codeberg, or others.

## Views

Shared view interfaces define tree-structured pages and how users can interfact with them, so that the job of each frontend is only to translate decorations to what's available on their platform.

## Packages

In approximate dependency order, Cabaret splits its packages into:

### Shared Libraries

- `patdiff`: patience diffing and diff4 translated from OCaml
- `cabaret-util`: standard non-Cabaret-specific utilities (e.g. branded types)
- `cabaret-core`: core operations and logic to work with Cabaret (e.g. log operations)
- `cabaret-views`: frontend-agnostic UI specifications (e.g. "home" page)

### Platform-Specific Libraries

- `cabaret-node`: native access via the Node runtime (e.g. `git` subprocesses)
- `cabaret-forges`: forge APIs (GitHub, GitLab, Forgejo)

### Frontends

- `cabaret-cli`: command line interface (optimized for agents)
- `cabaret-vscode`: VSCode extension (primary in-editor frontend)
- `cabaret-tui`: text-based user interface (in terminal, over ssh)
