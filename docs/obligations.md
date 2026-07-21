# Obligations

Obligations declare who must review which files. They are Cabaret's equivalent of `CODEOWNERS`, and are called "obligations" to signal that they are a responsibility: if you ask for the power to restrict others' changes, then you are obliged to be timely and helpful. They live in files in the tree so that policy moves, renames, and lands together with the code it governs.

## Blocking vs following

A rule demands one of two kinds of review:

- Gated "blocking" review: changes touching these files cannot land until the requirement is satisfied.
- Async "follow" review: the reviewers want to see the changes being made to these files, but landing does not wait for them. The review stays owed — through the land and beyond — until they catch up.

"follow" is the default kind, since blocking review imposes more restrictions.

## Files

A directory may contain at most one obligations file, named `.obligations`. It is JSON:

```json
{
  "rules": [
    { "match": "**/*.rs", "require": { "atLeast": 1, "of": ["alice@example.com", "bob@example.com"] } },
    { "match": "crypto/**", "kind": "blocking", "require": { "atLeast": 2, "of": ["alice@example.com", "carol@example.com", "dave@example.com"] } }
  ]
}
```

- `match` is a gitignore-style pattern, interpreted relative to the directory containing the file. A pattern without `/` matches the file's name at any depth; one with `/` matches the whole relative path, where `*` stops at separators and `**` does not. Dotfiles match like any other file. Patterns ending in `/` are rejected: rules govern files, not directories.
- `kind` is `"blocking"` or `"follow"`, and may be omitted for follow.
- `require` demands that at least `atLeast` distinct users from `of` review the file. Users are identified by email, as everywhere in Cabaret.
- `atLeast` must satisfy `0 < atLeast <= |of|`; anything else is unsatisfiable or vacuous and is rejected at parse.
- An optional top-level `"root": true` stops inheritance: obligations files in ancestor directories are ignored for this subtree.

## Semantics

The obligation on a file is the conjunction of every matching rule in every governing obligations file: the one in its own directory and those in each ancestor directory, stopping at a `root: true` file. Rules are read from the change's tip tree, so policy follows the code across moves and renames within the change itself. Per-directory files are harder to evaluate than a single repo-level `CODEOWNERS`, but that mechanism does not scale to large monorepos; in practice obligations files live at the level of projects or teams, not arbitrarily deep.

Inheritance is additive by design: a subdirectory can strengthen the requirements on its files but never weaken them. Weakening requires either editing the ancestor file or an explicit `root: true`, both of which are visible, greppable acts. Requiring everything to be a conjunction also keeps the rule language small:

- "all of these users" is `atLeast` equal to the set size,
- "and" is simply multiple matching rules,
- "or" across compound requirements is deliberately not expressible.

Independent of any rules, every governed file carries one implicit blocking requirement: the change's owner must review it. Writing the code is not the same as reading what the change came to say — after rebases, merges, and revisions, the owner lands the diff, not their memory of it.

Each of the change's reviewers — users added with `reviewers add`, or requested on the forge — carries the same implicit blocking requirement: a reviewer owes review of the change's whole diff, exactly as the owner does. Unlike rules in the tree, reviewers are per-change state, recorded in the log by `add-reviewer`/`remove-reviewer` entries with the latest entry per user deciding membership.

Beyond that floor, coverage is not required. A file matched by no rule obliges nobody but the owner, and a repository with no `.obligations` files demands nothing but self-review. Adoption is incremental.

## Satisfaction

A user counts toward a rule on a file when their review state covers the change's current base-to-tip diff for that file. The owner counts like any other user: a review is a review, whoever wrote the code.

A rule is satisfied when at least `atLeast` of its `of` users count. A change is sufficiently reviewed when every changed file's blocking obligations are satisfied, and `land` refuses until they are — short of an explicit override, which each frontend offers the way it offers the ownership override.

Follow obligations never hold a land. They surface the same way as any other review — on the todo page of each user whose review can still count — and a land leaves them standing: the landed change keeps asking until its reviewers catch up, reading the landed diff combined with wherever it went, as the review model's land transitions arrange.

Only files changed within the change's own review spans are governed. The diff a land merge brings in was reviewed in the landed child, under the child's own obligations, so it imposes nothing here.

Obligations introduce no new log action: satisfaction is a pure function of the tree and the existing `review` entries in the log.

## Changing policy

Rules are read from the tip tree, which alone would let a change weaken the very policy that should govern it. To close that hole, obligations files govern themselves: a change that modifies or deletes an `.obligations` file must have that file's diff reviewed so as to satisfy every requirement stated in the file's base version, each demanding the kind of review it states. The old policy signs off on its own replacement. This is deliberately coarse — any edit to the file, even to an unrelated rule, demands all of its requirements — trading precision for a rule that is easy to state and hard to game.

A newly added `.obligations` file has no base version and is governed by ancestor files as usual.

## Open questions

- Disjunction ("either two of the frontend role or one of the backend role"), time-based waivers ("or three days have passed"), and named roles as defined in one place and referenced by rules. Roles likely belong in the repository-root obligations file.
- A configurable floor on how many per-change reviewers a change must have, at the repository root or at `root: true` subtrees.
- JSON forbids comments, and policy files are a natural place to want them. Switching to JSON5 is cheap if this hurts in practice.
- Validation beyond the schema: rules whose patterns match nothing, unknown users, an `obligations check` command with precise source positions for errors.
