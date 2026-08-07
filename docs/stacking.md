# Stacking

Reviewing large combined changes is much more difficult than reviewing small contained ones, and so a good code review system must encourage its users to create small changes.

One common mechanism for doing this is so-called "stacked PRs", popularized in tools like [ghstack](https://github.com/ezyang/ghstack) and more recently officially adopted by GitHub and GitLab as full-fledged features.

Unfortunately, their implementations are fairly narrow, wanting to treat a "stack" as a single object that always follows a linear path and must be acted on all at once (causing pain for CI among other things). This is not how Cabaret sees stacks.

Instead, Cabaret sees stacking as the primitive expression of "I would like to write a change which depends on another change, even before that first change has landed". This is crucially what allows people to avoid feeling like they have to choose between either slowing down to wait for review or putting together one monster diff to be reviewed all at once.

This means Cabaret permits more flexible graph-like shapes than a single linear stack. It can consider among other things:

- Two changes which both depend on some initial infrastructure work, but which do not interact with each other.
- One change which relies on two other people's independent changes and doesn't know the order in which they will land.

The cabaret parent-child relationship graph can in this manner be thought of as the mutable + human-readable equivalent to the append-only + machine-friendly git commit graph.
