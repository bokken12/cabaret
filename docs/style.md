# Style

## State

Cabaret's source of truth is the git repo and the files backing it. This is a bit awkward for code which attempts to store state, as it can never truly be owned, and must always be considered a potentially-stale snapshot.

Therefore, Cabaret mostly operates in terms of "IDs" which can be thought of as references or pointers to its core data types (e.g. `ChangeId`, `WorkspaceId`). It operates largely on these IDs and fetches the latest copy of their data on demand when needed.

Since this results in a lot of repeated queries for the data of the same ID on which we are working, it reinforces the need for Cabaret to aggressively cache requests rather than re-deriving their state repeatedly.

## Repo

Cabaret's data and operations tend only to make sense in the context of a `gix::Repository` which they act upon and refer to items with. However, I avoid the `Struct<'repo>` pattern of linked lifetimes since a single Cabaret process only ever considers one repository, and there are not interesting distinctions to be made as to which values are linked to a repository.

Additionally, since we assume the state may change under us, we must already consider every handle to be potentially-invalid even during the appropriate lifetime. Therefore it does not cause additional pain to handle the invalid case a lifetime might have caught.

In an ideal world, we might treat the existence of this repository as something like an algebraic effect, which must always be supplied as a dependency and need not be explicitly named. Unfortunately, Rust does not offer this facility, and so we must consider other options:

1. We could make the repository (or its wrapper) a kind of god-object, attaching all relevant methods. Wherever we might have wanted `change.title()` we would instead write `repo.title(change)`.
2. We could make the repository a universal argument, passed into any method which would use it. Now instead of `change.title()` we might write `change.title(repo)`.
3. We could make the repository an implicitly shared global, finally allowing `change.title()` but at the cost of hiding the dependency adding a process-wide single-repo constraint that obstructs testing.

Ultimately, Cabaret has chosen to proceed with the first option as most honest, although it still attempts to structure its files around the individual pieces of data as if they owned their methods.
