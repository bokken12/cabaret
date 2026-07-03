# patdiff

Patience diffs in TypeScript — colored, with word-level refinement, ported from Jane Street's [OCaml `patdiff`](https://github.com/janestreet/patdiff).

- ASCII / ANSI / HTML output
- Word-level refinement of replaced lines
- Move detection
- Whitespace-aware diffing
- Numeric tolerance ("almost equal" floats are treated as equal)
- Recursive directory diffing
- CLI (`patdiff`) and library (`import { ... } from "patdiff"`)
- Ships ESM only, Node 20+

This is a private workspace package; depend on it with `"patdiff": "workspace:*"`.

## CLI

```sh
patdiff old-file new-file
patdiff old-dir/ new-dir/
patdiff -ascii old new
patdiff -html old new > diff.html
patdiff -context 5 old new
```

Exit codes: `0` no diff, `1` diff present, `2` error.

Run `patdiff -readme` for the full flag reference.

### Git integration

```sh
git config --global diff.external $(command -v patdiff-git-wrapper)
```

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

- `patdiff` — top-level Node-aware API (file I/O, config from `~/.patdiff`)
- `patdiff/kernel` — pure diff/format kernel (no Node deps; works in browser)
- `patdiff/patience-diff` — just the patience-diff algorithm (`Hunk`, `Range`, `getHunks`)
- `patdiff/ansi-text` — ANSI parsing and emission

## Configuration

A sexp config file at `~/.patdiff` is honored (same format as OCaml patdiff). Run `patdiff -make-config ~/.patdiff` to write a default.

## Differences from OCaml `patdiff`

- **Module names**: PascalCase types, camelCase functions/fields.
- **`Result` / `OrError`**: a `Result<T, E>` tagged union replaces `Core.Or_error.t`.
- **`Percent`**: a branded `number` brand replaces `Core.Percent.t`.
- **`Sexp`**: a small built-in parser handles the config-file format; we do not pull in a full sexplib.
- **Quickcheck property tests**: ported via `fast-check`.
- **`-readme` output**: raw text (no `groff | less` pipe).
- **`-include`/`-exclude` regex**: JavaScript `RegExp` syntax, not PCRE.
- **HTML mtime**: ISO 8601 UTC with millisecond precision (OCaml uses microsecond precision).

## Status

Beta. The kernel, library, and CLI are all translated from the OCaml source with the original expect tests preserved as vitest inline snapshots. The expect-test ground truth is OCaml's, so any divergence shows up as a failing snapshot. Two minor edge cases around blank-line consolidation in move detection are documented inline.

## License

MIT. Original patdiff © Jane Street; this port © Joel M.
