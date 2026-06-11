# Stack

Most of the tech stack is dictated by the desire to be a VSCode extension, meeting developers where they are:

- VSCode extensions are built in TypeScript, and so we shall be too in order to avoid heavy FFI or cross-compilation.
- VSCode extensions run on Node, and so we stick with it to avoid targeting multiple runtimes.

Outside of those basics we have more flexibility, but choose to use Biome for linting/formatting, and Vitest for testing.
