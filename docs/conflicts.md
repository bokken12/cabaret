# Conflicts

Conflicts are one of the biggest pain points when working with git. Therefore, they are an important element for Cabaret to think about in its design.

## Avoidance

In the best scenario one should avoid creating conflicts altogether. Cabaret's append-only ethos helps out with this somewhat, and possible future inclusion of mergiraf or similar drivers could help even further.

## Intermediate States

One of the worst features of git's default config resolution mechanism is how it creates unfinished intermediate states, in which the user is asked to resolve conflicts in order to finish an operation, or may need to abort the operation otherwise. Cabaret never allows an ongoing unfinished action: conflicts will always either immediately cause an operation to fail, or allow the operation to finish, leaving a change in a "conflicted" state.

## Detection & Representation

If changes can be "conflicted", it must be possible to determine which changes are in this state. A naive method here could search for conflict markers in the tree, but this would be quite expensive for basic operations like computing next steps (these may even appear on the home page and thus for many changes at once).

Therefore, Cabaret joins other git wrappers like jj in storing metadata concerning whether a commit has conflicts (a list of conflicted files). A new commit on a conflicted commit will have to update this metadata, but crucially the expensive operation occurs only on write, and not on read.

Note that commits made through plain git may not have this metadata. These may either be forced to fall back to naive tree inspection or simply assume no conflicts. This is not the officially-supported path, and can have some caveats.

TODO(joel): alternatively, conflict metadata could be an add/delete log so plain commits represent no change.

## Uniformity

Since conflicts are automatically committed, to minimize further conflicts on those conflicts, it is important that in the distributed system, if two people independently encounter the same conflict, they generate the same automatic conflict-containing commit. This means that we cannot allow users to specify their own conflict styles or merge drivers, but must impose a uniform style, at least per repository.
