Fixing a change's parents refuses with `base-moves` when it would move the change's base, as it does past a parent archived without landing, whose work the diff would then take in. `cab change parents fix --allow base-moves` overrides.

`BaseMoves::removed` becomes a set, naming every parent fixing removes.
