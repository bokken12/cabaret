# Cabaret: A Code Review Tool

Cabaret is a diff-based in-editor code review tool built on top of `git`.

## Website

The landing page, Quickstart, and Markdown documentation live in `website/` as regular files in this repository.

```sh
pnpm install --frozen-lockfile
pnpm dev:website
```

Run these commands from the repository root, then open http://127.0.0.1:3000. Run `pnpm build:website` to generate the static site in `website/out/`.

Write book chapters in `website/posts/`; the filename controls numbering and order. See [the website README](website/README.md#writing-documentation) for the chapter naming convention.

The website shares the root pnpm workspace and lockfile with the CLI bindings and editor extension. Run `pnpm --filter @cabaret/website typecheck` to check the website alone, or `pnpm check` to include the Rust workspace and editor extension.
