# Bugs

Bugs agents have noticed but not fixed, recorded so they can be picked up later. Remove an entry once it is fixed.

## Landing After a Conflicted Rebase Lands the Conflict Markers

`Cabaret::land` says conflicts are refused rather than landed, but it only checks for conflicts produced by the land merge itself. After a rebase that hits conflicts, the child's tip is a merge commit holding conflict markers, and it already contains the parent's tip. Landing the child is then a fast-forward. `Branch::merge` reports a fast-forward as having no conflicts, so the markers land in the parent.

Reproduce: `main` has `greeting.txt` as `hello`. `child` changes it to `hi`, then `main` changes it to `hey`. Rebase `child`, which commits the conflict markers, then land it. The land succeeds, and `main`'s `greeting.txt` is the conflicted text.

Possible fix: have `land` refuse when `Branch::conflicted_files` finds markers in the child.

## Review Mark Snapshots Are Stale

`integration::review::mark_defaults_to_bases_and_tip` and `integration::review::later_mark_replaces_earlier_one` fail on main. Their snapshots expect each mark as `BASE..TIP`, but marks now record only the tip. The snapshots probably just need updating, once it's confirmed that recording only the tip is intended.
