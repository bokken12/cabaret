Clean up clippy and oxfmt warnings

Makes cargo clippy and oxfmt --check pass with no warnings:
- Drops the unused humantime workspace dependency.
- Uses Option::map_or_default in LineCounts::new.
- Fixes the remaining pedantic lints: inline format args, semicolons on unit statements, and assert_eq for the empty-fold checks.
- Applies oxfmt to docs/branches.md, docs/safeguards.md, and vscode/package.json. These are formatting-only changes.