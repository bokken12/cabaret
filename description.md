In the cabaret CLI, we should support rebase ranges. Notably, on input like
```
cab change rebase descendant..ancestor
```
we should confirm that descendant in fact descends from ancestor, and if so follow the path from ancestor to descendant, rebasing onto the direct parent at each node such that eventually the descendant is caught up with ancestor.

Note that we should not rebase any of these nodes on their other parents, only along this path. We probably should not rebase the ancestor at all (exclusive).

I suggest this .. notation to follow git, but I could be persuaded that this should replace the onto arg or similar. Open to discussion.

If any rebase in the chain creates conflicts, we should stop at that point.