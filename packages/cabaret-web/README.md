# cabaret-web

Cabaret's review pages as a standalone website. The whole app runs in the
browser against the GitHub API — no server: `GitHubBackend` reads and writes
review state through the Git database API, and `GitHubForge` lists pull
requests, so browsing, reviewing, and importing work from any static host.

On first load the app asks for a repository (`owner/repo`) and a GitHub
access token; both are kept in the browser's local storage and the token is
sent only to `api.github.com`.

```sh
pnpm --filter cabaret-web dev    # local development server
pnpm --filter cabaret-web build  # static site in dist/
```

Pages are addressed by URL fragment — `#/todo`, `#/show/<change>`,
`#/review/<change>`, `#/diff/<change>:<file>` — mirroring the page paths the
VS Code extension uses. Operations that need a working tree (rebase, rename)
are not offered; they live in the CLI and VS Code extension against a local
checkout.
