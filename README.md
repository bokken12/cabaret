# cabaret

A personal/local-first code review tool inspired by Jane Street's [Iron](https://github.com/janestreet/iron), built to replace the GitHub PR review experience without requiring a server or team adoption.

Design overview: [docs/README.md](docs/README.md). Roadmap: [docs/roadmap.md](docs/roadmap.md).

## Workspace layout

```
packages/
  core/      # brain logic, diff algorithms, types — pure, no I/O
  backend/   # Backend interface + git-transport implementations
  cli/       # the `cabaret` CLI
```

## Development

```sh
pnpm install
pnpm build       # compile all packages
pnpm typecheck   # tsc -b --noEmit
pnpm test        # vitest across packages
pnpm lint        # eslint
```

Node ≥ 20. Package manager is pnpm 9.
