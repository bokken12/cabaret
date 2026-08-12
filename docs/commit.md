# Commit

## JJ

JJ makes a fairly novel choice in the VCS space by removing "commit" as an action you can take. Instead, it implicitly commits/amends the working copy constantly on each command.

This comes with some real benefits. You always have history to revert to, and you can always swap take actions like swapping between changes or merging without worrying about unclean states or maintaining stashes.

Of course, it also comes with some footguns. It can be harder to delineate and discard small pieces of scratch work, and easier to accidentally commit secrets or other data that should not live in the VCS.

## Cabaret

It is tempting for Cabaret to adopt this same mindset. However, I believe that would be a mistake.

We must come back to the goal that Cabaret is primarily a code review tool.One of the things it does to optimize for that is to automatically sync with the remote, to make sure you aren't accidentally reading old versions of code. I believe this is the right choice for a particularly collaborative part of the software development cycle.

However, this means that anything committed, will in short order be made available to reviewers. Another thing common in code review is for people to go back and forth: writing and responding to each other's comments. During this process, one should ideally not see half-finished sentences to review as a response was being composed.

Therefore, I believe that despite Cabaret's usual insistence that commits and the commit graph are not something for human consumption, there remains a role for humans to mark "this is a complete unit which is ready for review by others. This action may as well be called a commit.

## Counter-Arguments

This is not the only possible mechanism, and it is worth considering others. To the extent, for example, that we do not want to waste reviewers time reading a half-finished sentence, it may also be the case that reviewers should more generally not review while there are active edits in progress.

Therefore, perhaps an alternate system could make commits automatic and nudge users that they should "lock" the change by disabling review or setting themselves to be the sole reviewer as they are making changes. In general some form of per-change locking seems like a potentially sensible thing for an age of many agents? The action of publishing could then be re-enabling review rather than committing.
