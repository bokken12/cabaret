# Architecture

Notes on how the code should be structured and why.

## Language

Cabaret will be written in TypeScript to permit a VSCode extension without FFI.

## Packages

Cabaret will have at least 3 different frontends:

- `cabaret-cli`: a command line interface
- `cabaret-web`: a standalone web UI
- `cabaret-vscode`: a VSCode extension

`cabaret-web` and `cabaret-vscode` will hope to share most of the same UI and a substantial portion of code, likely with the VSCode extension effectively embedding the website (or the reverse with the website recreating some basic editor functionality).

All of these frontends will be built around some `cabaret-core` defining basic operations against multiple possible backends, of which the primary will be to shell out to a local `git`.

It may also be useful to create a shared UI library between Cabaret and the Edamajutsu porcelain for JJ to create a unified feel, but this can come later.
