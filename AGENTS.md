# Cabaret

In the Cabaret repository, please follow Cabaret conventions. Notably:

- Commit eagerly to share your work, but don't land yourself without review.
- Prefer dogfooding `cab` CLI to plain `git`. You can run your local CLI with `pnpm cab`.
- If you notice something that could be improved about Cabaret, consider adding it as a separate change for review.
- Slice diffs thinly. If you're working on a bigger project consider whether you can split it into a stack of smaller pieces.

`docs/` describes the main architectural decisions. It is only for humans to write to, so if you conclude a new doc is necessary, please create a change with a TODO in the description for a human to write it rather than making it yourself.

## Code Style

- Prefer precise types (e.g. `NEBTreeSet` over `Vec` when assumed to be unique/unordered/non-empty)
- Consider crate structure when adding new code (does your shared type belong in `cabaret-types`)
