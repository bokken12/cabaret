# Architecture

Notes on how the code should be structured and why.

## Language

Cabaret will be written in TypeScript to permit a VSCode extension without FFI.

## Packages

Cabaret has 3 frontends:

- `cabaret-cli`: a command line interface
- `cabaret-web`: a standalone web UI, served as a static site with no server of its own
- `cabaret-vscode`: a VSCode extension

The interactive frontends share their UI through `cabaret-views`: pure functions from queried state to plain-text documents, with each frontend a thin host that paints documents and routes keys. In particular the VSCode extension renders into real text buffers rather than embedding the website, so editor navigation (including vim emulation) works untouched. See [ui.md](ui.md).

All of these frontends are built around `cabaret-core`, which defines basic operations against multiple possible backends. The primary, `GitBackend` (`cabaret-node`), shells out to a local `git`. A second, `GitHubBackend` (`cabaret-github`), speaks the GitHub API instead — no clone, no working tree — which is how `cabaret-web` reviews, comments, and lands from a browser; the operations that genuinely need a working tree (`rebase`, `rename`, a checked-out branch) exist only on the local backend and fail there with a pointer to a checkout.

It may also be useful to create a shared UI library between Cabaret and the Edamajutsu porcelain for JJ to create a unified feel, but this can come later.
