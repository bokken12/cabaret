# patdiff

Patience diffs in TypeScript — colored, with word-level refinement, ported from Jane Street's [OCaml `patdiff`](https://github.com/janestreet/patdiff).

- ASCII / ANSI / HTML output
- Word-level refinement of replaced lines
- Move detection
- Whitespace-aware diffing
- Numeric tolerance ("almost equal" floats are treated as equal)
- Recursive directory diffing
- 4-way diffs (`import * as Patdiff4 from "patdiff/patdiff4"`), ported from Iron's `patdiff4`: given the old and new base and tip around a rebase, show a reviewer who knows the old diff what changed about the diff itself
- Ships ESM only, Node 20+

This is a private workspace package; depend on it with `"patdiff": "workspace:*"`.

## Library

```ts
import * as Patdiff from "patdiff";

const result = Patdiff.PatdiffCore.withoutUnix.patdiff({
  prev: { name: "old", text: "old\ntext\n" },
  next: { name: "new", text: "new\ntext\n" },
});
console.log(result);
```

### Sub-packages

The library is layered. Direct imports if you want a smaller surface:

- `patdiff` — top-level Node-aware API (file I/O)
- `patdiff/kernel` — pure diff/format kernel (no Node deps; works in browser)
- `patdiff/patience-diff` — just the patience-diff algorithm (`Hunk`, `Range`, `getHunks`)
- `patdiff/ansi-text` — ANSI parsing and emission

## Differences from OCaml `patdiff`

- **Module names**: PascalCase types, camelCase functions/fields.
- **`Result` / `OrError`**: a `Result<T, E>` tagged union replaces `Core.Or_error.t`.
- **`Percent`**: a branded `number` brand replaces `Core.Percent.t`.
- **Quickcheck property tests**: ported via `fast-check`.
- **`-include`/`-exclude` regex**: JavaScript `RegExp` syntax, not PCRE.
- **No standalone CLI or `~/.patdiff` sexp config**: this port is library-only.
- **HTML mtime**: ISO 8601 UTC with millisecond precision (OCaml uses microsecond precision).

## Status

Beta. The kernel and library are translated from the OCaml source with the original expect tests preserved as vitest inline snapshots. The expect-test ground truth is OCaml's, so any divergence shows up as a failing snapshot. Two minor edge cases around blank-line consolidation in move detection are documented inline.

## License

MIT. Original patdiff © Jane Street; this port © Joel M.
