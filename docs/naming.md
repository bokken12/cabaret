# Naming

How changes are identified, named, and renamed.

## Identity

Every change is identified by a `ChangeId`: random, minted at `create`,
immutable. The log ref is keyed by it. Identity cannot live in a name
because a name-keyed ref cannot be renamed under union replication: a
rename at origin is a delete and a create, and any clone that has not
heard resurrects the old ref on its next push, splitting the log.
ID-keyed refs never move, so replication never sees a rename.

IDs are for machines: land trailers carry them so land detection survives
renames, and the CLI accepts them (by unique prefix) to disambiguate.
Humans see names.

## Names

A change's name is log state: `create` records the initial name,
`set-name` renames. The branch mirrors the current name — renaming a
change renames its branch locally and at origin, and retargets the forge
change where the forge supports it (GitHub renames the branch under a PR;
GitLab cannot, and there the forge branch keeps the old name).

A branch left on a former name is a stale alias: fetch recognizes any
name in a log's history and joins the branch's commits into the change's
branch, so a collaborator on plain git pushing to the old name loses
nothing.

Names are unique among live changes by convention, not invariant —
nothing structural can enforce uniqueness under union replication. Fetch
nudges the later claimant of a collision. A name resolves live over
archived, then by most recent activity; ambiguity among live changes is
an error offering IDs. Archiving releases the name (as in Iron, whose
archive keys features by ID and repeats paths freely).

## Parents

A parent reference is either a change, by ID, or a bare branch, by name.
The ID arm is always preferred; the name arm is written only when the
parent has no change — long-lived branches like trunk, which in practice
never rename. Making such a branch a change needs no fixup: existing
name-arm references resolve through the branch the change now owns, and
new references use its ID.

## Lookup

Resolving a name means finding the log that claims it, which must not
require reading every log. A local index maps each name to its id and the
log ref it was read at; an entry is verified against the ref before use
and re-read when stale, and fetch updates the index incrementally. The
index is derivable state and never replicates.
