# Architecture

Notes on how the code should be structured and why.

## Language

Cabaret will be written in TypeScript to permit a VSCode extension without FFI.

## Packages

Cabaret will have at least 3 different frontends:

- `cabaret-cli`: a command line interface
- `cabaret-web`: a standalone web UI
- `cabaret-vscode`: a VSCode extension

The interactive frontends share their UI through `cabaret-views`: pure functions from queried state to plain-text documents, with each frontend a thin host that paints documents and routes keys. In particular the VSCode extension renders into real text buffers rather than embedding the website, so editor navigation (including vim emulation) works untouched. See [ui.md](ui.md).

All of these frontends will be built around some `cabaret-core` defining basic operations against multiple possible backends, of which the primary will be to shell out to a local `git`.

It may also be useful to create a shared UI library between Cabaret and the Edamajutsu porcelain for JJ to create a unified feel, but this can come later.
