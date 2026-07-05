# Roadmap

## CLI & Review State

Build out `cabaret-cli` which allows updating brain review state and PRs.

## Testing

Set up infrastructure for manipulating git repos in test and expecting their final state after some operations.

## Change Enumeration & Summaries

The queries a UI needs, in core: enumerate all changes, build the parent/child tree from `set-parent` entries, and summarize a change — owner, work remaining, forge state, and a computed next step.

## Text Views

The `cabaret-views` doc model plus the todo and show views (see [ui.md](ui.md)), exercised as `cabaret todo` and `cabaret show` CLI commands with snapshot tests.

## VSCode Plugin

Buffers for todo and show behind a `cabaret:` scheme: enter visits the thing under the cursor, a key refreshes.

# Future

## Cabaret Web

## Roles & Review Obligations
