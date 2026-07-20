# What Review Is Owed

One rule: a reviewer owes a file when the latest review that speaks for it
no longer covers the file's current diff.

- The **current diff** is `base → tip`, read per file.
- A **review** is a `{base, tip}` pair: an entry someone recorded in the
  log, or the implicit review a **land merge** stands for — a land only
  happens with the landed diff reviewed (or expressly waived), so the diff
  `onto → commit` it wrote counts as reviewed, for everyone at once, on
  each file it brought in.
- For each file, the review that reaches furthest wins: a person's own
  record, unless it predates a land that covers the file.

## Views

- No review: the plain diff, base to tip.
- A review at the current base: the diff onward from its tip — nothing at
  all when the file has not changed since.
- A review whose base has moved (a rebase happened): the four-way
  comparison of the reviewed diff with the current one. Empty — the rebase
  carried the change cleanly — discharges the review silently; anything
  else shows exactly what moved, conflict resolutions included.

There is one round of review: the change as it currently stands. Marking a
file records `{base, tip}` of the diff displayed; marks at mid-history
tips are fine and simply leave the diff onward from them.

## What this deliberately gives up

- No reading order: there is no "absorb the landing before newer work" —
  reviewers always read the change as it is now.
- A land's implicit review is trusted as a whole: content that entered
  through a land is re-examined only when its diff later moves (then the
  four-way shows the movement, never the whole child again). A
  cherry-picked land commit carries the same trust, resolutions and all.
