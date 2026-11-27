A change's parents are exactly those its log records; nothing derives them from other changes' state behind the read. `Metadata::parents()` becomes `Metadata::fixed_parents()`, which only fixing, its next step, and its safeguard consult.

- An archived parent, or one already an ancestor of another, stays until `cab change parents fix` replaces or drops it. Base, diff, review, children and the home graph all read the recorded parents, so they move only when the change's own log does.
- "fix parents" is the first next step of a change whose parents need fixing.
- Land and rebase refuse with the new `unfixed-parents` safeguard, which `--allow unfixed-parents` overrides.
- Landing leaves the children's parents alone: the landed change stays on home above them, marked "(archived)", until each is fixed.
- `ChangeSnapshot::declared_parents` is gone, being the same as `parents`.
