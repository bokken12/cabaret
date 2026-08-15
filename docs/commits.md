# Commits

Rebase vs merge. Squash vs preserve. These are the debates that have plagued git users since the dawn of time. These along with some others essentially boil down to a single question:

> should the git commits be "pretty" or "tell the story" of the development?

Cabaret answers this with an emphatic "no", and let me briefly argue for why.

## Why No Sausage-Making

In git, commits are the smallest atomic unit at which you can track history. They are the level at which changes on your local machine can be synced to and from a remote. This is a very important role.

When developing code, people do not often proceed along a perfectly designed story in which they write the first piece perfectly, followed by the second piece. Instead, they tend to go back-and-forth, requiring some iteration to get things right.

So in order to align our atomic unit with a desire for a story, people typically have to do one of two things:

- Either they avoid making commits until they have finished their iteration, after which they can commit pieces to craft their story, essentially forgoing the benefits of version control. This is unacceptable and so will not be considered.
- Or they do their work with a somewhat messy version control history, and then afterwards run some kind of a clean-up pass. Euphemistically, this is referred to as "sausage-making", where you don't want to see "how the sausage is made" before the history is wiped clean.

This second method can work fairly well, and can make code easier to review for others by laying out a nice story. However, it has some costs.

In particular, git really works best as an append-only log. This allows its synchronization primitives to work smoothly: understanding what pieces you have or have not yet seen, and fast-forwarding to give you the collection of all changes.

When you violate this, editing the history, git can no longer tell which of the original commits line up with your new cleaned-up versions. This forces everyone interacting with your branch to do "force-push" style operations, where they either abandon their local copy or the remote changes. It makes merge conflicts more prevalent and more difficult to resolve. This is bad for a version control system.

## Where's The Story?

Still, it is not a bad instinct to want to be able to tell some kind of a story: Cabaret is primarily a code review tool and wants to make following the changes made as easy as possible.

So the key insight here is that giving up on using the commit graph as a story does not mean we have to give up on the idea of a story altogether.

In Cabaret, the commit graph is seen as being for the computer. Cabaret will not ask you for commit messages, since commits are not something designed for you or any other humans to look at. If we accept this premise, we can make them arbitrarily ugly, and work arbitrarily well to sync state and minimize conflicts.

The story instead lives in Cabaret's changes. For a human, the change should be the atomic unit they concern themselves with. It's what they should review. It's what they should revert. It's what they should parcel their large project into. Yet letting the system below understand a more granular history of that abstraction allows it to work even better for you.

## Answers

So Cabaret says always to merge when possible: avoid squashing or rebasing in order to stay on the happy path. It does its best to understand and accommodate for collaborators who may not share this vision, but would encourage them to consider it to make things better for everyone.
