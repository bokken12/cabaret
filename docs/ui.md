# UI

How the interactive frontends (VSCode, web, maybe a TUI) are structured and why.

## Goals

- **Text-first.** Every surface is plain text on a monospace grid, navigated with a cursor. In VSCode this means real text buffers, so vim keybindings, search, and everything else the editor provides work untouched.
- **One view implementation.** The same rendering drives the CLI, VSCode, and the web; each host is a thin adapter.
- **Pure and snapshot-testable.** Rendering is a pure function of queried state; tests pin exact output, the same way Iron's cram tests pin the whole `fe` surface.

## Design space

### How to draw inside VSCode

1. **Embed a web app in a webview.** One codebase for web and VSCode (Iron's fe-web works this way). But a webview is an iframe: the user's vim extension, incremental search, and registers don't reach inside it. The text-first goal dies here unless we reimplement editor navigation ourselves.
2. **Native contributions** (TreeView, QuickPick). Cheap and keyboard-friendly, but not text buffers, not vim-navigable, and layout-rigid.
3. **Virtual text documents** via `TextDocumentContentProvider` on a `cabaret:` URI scheme (edamagit works this way). The UI is an ordinary read-only buffer: editor navigation comes for free, coloring comes from a semantic tokens provider, and interaction is contributed keybindings gated on the buffer's language id.

We take (3). The standalone website then becomes another host over the same views, rather than the thing VSCode embeds — the reverse of the fe-web layering.

### What the shared view layer is

1. **Share nothing.** Each host renders natively from core queries. Maximal fidelity per host, but N view implementations that drift apart.
2. **Retained component tree** (edamagit). A tree of view objects; `render()` returns lines while assigning each node its line range as a side effect; "what's under the cursor" is a recursive hit-test returning the node, and commands `instanceof`-dispatch on it. Proven in practice, but the ranges are mutable state valid only immediately after the render that wrote them, documents don't serialize because identity lives in class instances, and presentation state (folding) hides in a global map keyed by ad-hoc ids.
3. **Documents as values.** A view is a pure function from queried state to a `Doc`: lines of styled spans, where a span may carry a semantic *target* (a discriminated union: this change, this file). Hit-testing is a pure lookup from position to target. The doc serializes, snapshot-tests directly, and is host-agnostic by construction.

We take (3). It keeps the load-bearing idea from edamagit — rendered text in which every meaningful span knows what it denotes — while making the document a value rather than a mutation protocol.

What this gives up, knowingly:

- **No component framework.** Views are concrete functions; shared helpers (tables, trees) get extracted when a second view needs them, not before.
- **Plain text bounds web richness.** A `Doc` cannot express side-by-side panes or images. Acceptable: hosts are thin, so a web host that eventually wants more can render some pages its own way without forking the rest, and patdiff already has an HTML backend for that day.

## The model

```ts
type Doc = { lines: Line[] };
type Line = { spans: Span[] };
type Span = { text: string; style?: Style; target?: Target };
type Target =
  | { kind: "change"; change: RefName }
  | { kind: "file"; change: RefName; file: FilePath };
```

- `Style` is semantic (`heading`, `dim`, `added`, ...); each host maps it to its own palette: semantic tokens, DOM classes, ANSI.
- `targetAt(doc, line)` resolves the cursor's line to a target: selecting a line is the granularity a cursor should need, not a column within it. Hosts own their keymaps and dispatch on the target's `kind` — enter on a change's row opens its show page.
- Views consume plain snapshots assembled from `Backend` queries and core derivations (`brain`, `reviewSegments`, ...); the snapshot type is the view's whole input.
- Refresh re-queries and re-renders the whole doc. Docs are small; no diffing.
- Presentation state (folding, filters), if any, is an explicit argument to the view function, never hidden inside it.

## Views

Iron's surfaces, under Iron's names:

- **todo** — the landing page: what needs your attention. A section of changes awaiting your review and a section of changes you own, with the parent/child tree drawn as indentation in the name column, plus columns for work remaining and **next step** — a verdict computed from the log (`add code`, `review`, `land`, `rebase`) rather than raw state. When the forge is reachable, open pull requests with no change log yet stand in for the changes importing them would create: they appear in the review section (every file counts as unreviewed) and, when you authored them, under changes you own, with next step `import`. Importing one — enter on its row, `! i` in VS Code, or `cabaret gh import` — materializes it.
- **show** — one change: an attribute table (next step, owner, tip, base, forge request), files with per-file review state, comments.

Both render through the same view functions in every host, including the CLI (`cabaret todo`, `cabaret show`), which is the cheapest place to exercise them first.

## Packages and hosts

- `cabaret-views`: the doc model, snapshot types, and view functions. Pure; no `vscode`, DOM, or Node imports.
- `cabaret-cli`: paints docs with ANSI. The first host.
- `cabaret-vscode`: content provider + semantic tokens provider + contributed keybindings. Runs in the extension host (Node), so it uses `GitBackend` directly — no server.
- `cabaret-web`: spans to DOM nodes. Because docs are values, views can render server-side and ship as JSON if a thin client is ever wanted.
- A TUI would be another ANSI painter with its own cursor tracking; possible, not planned.

## Open questions

- **Writing, not just reading.** Content-provider buffers are read-only; composing a comment magit-style (type into the buffer, then commit it) would need a `FileSystemProvider` or plain input boxes. Start with input boxes.
- **Naming clash.** `todo` (the dashboard, Iron's name) sits one letter from the existing `todos` (code TODOs a change adds, Iron's CRs). Consider folding code TODOs into the show page, or renaming one.
- **Shared keymaps.** Each host binds its own keys; a keymap-as-data layer shared across hosts is only worth it once two interactive hosts exist.
