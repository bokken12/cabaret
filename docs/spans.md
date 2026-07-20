# Review Spans

A change's diff is read as one or more **spans**: windows of the tip's
first-parent chain, each reviewed as the plain diff between its endpoints.
One span is the ideal — the whole change, read at once against its base.

## Cuts and restarts

Two kinds of merge on the chain carry a diff that was already reviewed
elsewhere, and the span walk treats them differently:

- A **land merge** (`Cabaret-Landed` trailer) brought in a child reviewed
  under its own log. It **cuts**: the open window ends at the merge's first
  parent, the next begins at the merge, and the landed diff falls in the gap.
- A **rebase merge** (its second parent is already reachable from the base)
  brought in parent history reviewed where it landed. It **restarts** the
  open window at the base it merged in: everything before it is re-expressed
  in the diff from that newer base, so the window stays one current diff,
  conflict resolutions included.

A rebase merge *behind* a land cut cannot restart — re-anchoring a window
that starts at a land commit onto the moved base would re-open the landed
diff — so it cuts like a land, and its own delta goes unreviewed
(resolutions committed as follow-up commits are still covered).

## Consequences

- With no lands on the chain, any number of rebases still yields exactly one
  span: the current base→tip diff.
- Each land splits review at the land. A reviewer current at land time still
  sees one pending window; only reviewers behind at land time face several,
  the earlier ones expressed against old bases.
- `land` therefore requires the *parent's* obligations satisfied too
  (`--even-though-parent-unreviewed` overrides), so lands rarely happen over
  anyone's pending review.

## Reviews across rebases

A recorded review pins the `{base, tip}` it read. When the base has moved,
the record is compared against the current diff file by file — an empty
comparison (the rebase carried the change cleanly) discharges the review
silently; a real difference shows as a four-way old-diff/new-diff view.

## Carried reviews

What a land brings in stays excused only while the child's review still
covers it. Each land carries the child's reviewed `{base, tip}` pair from
its log; a brought-in file whose current diff has moved past that pair —
a conflict resolution amended into a rebase merge, trunk work interacting
with the child's edit — resurfaces in a final round, viewed four-way from
the pair. A carry that leaves the diff intact discharges silently. A child
whose log or history this clone lacks vouches for its files
unconditionally.

## Known gap

A rebase merge behind a land cut still hides amended resolutions in files
only the parent itself touched before the land: those sit in the pinned
early spans, whose windows end before the merge. Resolutions committed as
follow-up commits are covered, as are ones in files the child touched,
which carried reviews resurface.
