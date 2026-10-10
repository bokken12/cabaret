A change's parents are exactly those its log declares; nothing derives them from other changes' state any more. Archived and redundant parents stay until `cab change parents fix` removes them, so a child's base and diff only move when its own log changes.

- Fixing parents is now the next step for a change with an archived parent, or with a parent that is already an ancestor of another.
- Land and rebase refuse with the archived-parent and redundant-parent safeguards. Unarchive and add-parent refuse with them too, but only for parents they would newly leave unfixed. The archived-parents safeguard is gone.
- Fixing refuses with base-moves when it would take a removed parent's work into the diff, e.g. for a parent archived without landing.
- `children` and the home graph read parents directly, so an archived parent is drawn until its children are fixed.
- `declared_parents` is renamed to `parents` throughout, including `ChangeSnapshot`.

TODO(joel): docs/safeguards.md still says archived and ancestor parents are skipped by parent inference.