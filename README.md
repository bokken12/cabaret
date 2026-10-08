# Cabaret: A Code Review Tool

Cabaret is a diff-based in-editor code review tool built on top of `git`.

## Website

The landing page, Quickstart, and Markdown documentation live in `website/` as regular files in this repository.

```sh
cd website
npm ci
npm run dev
```

Open http://127.0.0.1:3000. Run `npm run build` to generate the static site in `website/out/`.

Write book chapters in `website/posts/`; the filename controls numbering and order. See [the website README](website/README.md#writing-documentation) for the chapter naming convention.

The website currently has its own npm lockfile and is separate from the pnpm workspace used by the CLI bindings and editor extension.
