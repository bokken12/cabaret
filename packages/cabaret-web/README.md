# cabaret-web

Cabaret's review pages as a standalone website. The whole app runs in the
browser against the GitHub API — no server: `GitHubBackend` reads and writes
review state through the Git database API, and `GitHubForge` lists pull
requests, so browsing, reviewing, and importing work from any static host.

On first load the app offers "Sign in with GitHub", then a picker over the
repositories the login can reach; pasting an access token works as the
fallback for hosts serving only the static files. Token and repository are
kept in the browser's local storage, and the token is sent only to
`api.github.com`.

Signing in needs the bundled server, which adds the one step a static site
cannot do itself: GitHub's OAuth code-for-token exchange. Register an OAuth
app (callback URL `<origin>/oauth/callback`), put
`{"clientId": ..., "clientSecret": ...}` in
`~/.config/cabaret-web/oauth.json`, and serve with:

```sh
pnpm --filter cabaret-web build  # site in dist/site, server in dist/server
pnpm --filter cabaret-web serve  # serve both; --port, --bind, --root, --oauth
pnpm --filter cabaret-web dev    # local development server (static only)
```

Pages are addressed by URL fragment — `#/todo`, `#/show/<change>`,
`#/review/<change>`, `#/diff/<change>:<file>` — mirroring the page paths the
VS Code extension uses. Operations that need a working tree (rebase, rename)
are not offered; they live in the CLI and VS Code extension against a local
checkout.
