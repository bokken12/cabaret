# Reviewing

Who is asked to review a change right now. Obligations say who must review
before a change lands; the reviewing set says whose turn it is. It is one
ordered value per change, recorded by `set-reviewing` entries in the log:

- `none` — the change is not ready for review. Nobody is asked, not even the
  owner; a forge shows the change as a draft.
- `owner` — the owner reads their own diff. Where `create` starts a change.
- `reviewers` — the owner and the change's reviewers.
- `everyone` — anyone; the obligations files alone decide who is asked. Where
  a log that never set a reviewing set reads, so imported forge changes need
  no entry.

The set is symbolic: `reviewers` tracks the reviewer list as it changes
rather than freezing its members.

## Widening

Review normally widens one step at a time — the owner finishes self-review,
adds reviewers, widens to them, and finally widens to everyone. `widen` takes
the next step, skipping any level that would ask nothing of anyone: a level
asks something when a user it newly adds still has review left, so an owner
who already read the whole diff is skipped, as are reviewers who have (or a
change with none), landing on the first level with real review to do or on
`everyone`. `reviewing <value>` sets the level directly, in either direction;
narrowing back to `none` is how a change goes back to being a draft.

## What the set gates

Todos. A change appears as review work only for users the reviewing set
includes, which the log alone decides — so building a todo page reads the
obligations files of just the changes whose set reaches the user, most of
which it does not.

Nothing else. Obligation satisfaction is a pure function of the tree and the
review entries, and `land` requires every obligation satisfied whoever is
currently reviewing — an obligation only someone outside the set can satisfy
is exactly what forces widening.

## Forges

A forge expresses reviewing as one boolean: draft or ready. The two sides map
across the `none` boundary — pushing a change nobody is reviewing opens (or
converts to) a draft, and widening past `none` marks it ready. The gradations
above `none` stay Cabaret-local.

Mirroring in follows the observation principle used for parents and
reviewers: only a forge that crossed the boundary since last observed writes
entries, so a local `set-reviewing` awaiting its push is never overridden. A
forge-side "convert to draft" mirrors in as `none`; "ready for review"
mirrors in as `everyone` — the forge-faithful reading, under which a ready
forge change behaves exactly as its forge treats it: open to anyone.
