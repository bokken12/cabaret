# Conflicts

Conflicts are one of the biggest pain points when working with git. Therefore, they are an important element for Cabaret to think about in its design.

## Avoidance

In the best scenario one should avoid creating conflicts altogether. Cabaret's append-only ethos helps out with this somewhat, and possible future inclusion of mergiraf or similar drivers could help even further.

## Intermediate States

One of the worst features of git's default conflict resolution mechanism is how it creates unfinished intermediate states, in which the user is asked to resolve conflicts in order to finish an operation, or may need to abort the operation otherwise. Cabaret never allows an ongoing unfinished action: conflicts will always either immediately cause an operation to fail, or allow the operation to finish, leaving a change in a "conflicted" state.

## Representation

Some recent VCSs, notably jj, adopt novel conflict representation, storing the merge's input trees as metadata. This is an interesting strategy, allowing for some enticing algebra over conflicts. However, this requires materialization from a special conflicting trees format into something that git can understand, which is not something Cabaret wants. The conflict must exist in the file, as understood natively by git.

One further alternative here could be to keep both some metadata representation and the default git view: either to permit greater manipulation or just for efficiency to avoid searching. However, muddying the waters on the source of truth here feels undesirable, and so is also discarded. Ultimately, conflicts will be the conflict markers.

## Detection

Cabaret must work on large monorepos, and so scanning the entire codebase for conflicts is a non-starter, especially when determining the presence of conflicts is necessary for almost all common operations, and even on many changes at once to determine their status in the home page. We must limit our search space (along with caching).

To do this, Cabaret searches for conflicts through only the files which have been edited in a given change since a common ancestor with any of its parents (effectively since its bases). Users are not permitted to rebase onto parents which currently have conflicts, so any conflicts which exist must have occurred since then.

The one exception here is the trunk branch which has no parents, but the trunk is never considered conflicted, since landing is not allowed to introduce conflicts. Similar mechanisms can be used to find TODOs introduced in a change.

## Uniformity

Since conflicts are automatically committed, to minimize further conflicts on those conflicts, it is important that in the distributed system, if two people independently encounter the same conflict, they generate the same automatic conflict-containing tree. This means that we cannot allow users to specify their own conflict styles or merge drivers, but must impose a uniform style, at least per repository. Diff3 is likely the best default.

## Non-Textual

Conflicts which occur in binary files or involve editing a deleted file or renaming a file twice cannot as easily have markers placed within the text. These may end up with special markers on adjacent files to help users identify and resolve the conflict, but for now will not be a concern.
