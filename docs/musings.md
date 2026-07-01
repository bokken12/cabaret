# Musings

## Changes vs Branches

Should there be a 1:1 mapping from branch to change?

This feels in some ways restrictive, and like a thing that people criticize about GitHub. Still, it seems kind of convenient? And when could you really want the same branch to be reused for multiple changes?

## Squash vs Merge

do I squash in rebase?

I feel like there's something wrong with rebases, that they somehow don't keep the history properly. Maybe they're actually supposed to merge?

I feel like append-only is kind of correct in which case maybe rebases are wrong?

Oh okay, this is just that I need to rebase onto reliably.


## Post-Landing

How can I track review that happened in a child feature that landed?

It seems like I guess what you want to happen is for the child to be fully reviewed, at which point its diff should effectively get reviewed, like it should almost act as if it becomes part of the base.

alternatively it becomes like, it stays a child, hmmmmmmm, this is complex.

can I impose a rule that you can't release into a parent before it has been fully reviewed? that's honestly not so crazy

next step: (review in parent)

then if the parent is fully reviewed you can just update everyone else's review pointers for them

this all makes it a little bit less happy on top of jj, since undo is no longer as clean.

can jj be made to treat this all as a unit?

When a change has landed, it should not be required for review. This will be identified in the commit.

When you review in the UI, it will look for the first such commit, then review up to that. You may then have further review if there has been more work since then.

## Compression

Should landing a change and compressing it be two different steps?

I guess I kind of want to say yes? It's a little bit awkward for the answer here to be yes, since it creates an additional step for users. However it is intuitively a different action which need not be linked

## Code Ownership

Iron enforces that every piece of code have a single "owner". Honestly this feels kind of vestigial to me: maybe it's just a mistake? Much code in the world should be considered to be collectively owned.

I do think feature owners are probably still sensible to have though. Maybe multiple owners should be allowed, but.
