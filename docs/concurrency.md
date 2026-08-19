# Concurrency

For the most part, version control is a sequential story. On one end its `gix` backend is largely sequential since there are few opportunities for wins from introducing concurrency. On the other, its users are likely taking only one action at a time and not spawning multiple long-running processes.

## Exceptions

Nonetheless, there are a few cases where Cabaret must consider concurrency. In particular, in UIs built atop Cabaret, it is important that running some large merge or similar does not remove interactivity. Large tasks should be offloaded to workers.

## Locking

We should only ever perform one mutating operation on a change at a time. Git already provides this guarantee on its refs, but we want to expand the critical section to avoid TOCTOU issues. Therefore, Cabaret keeps its own per-change locks in `.git/cabaret`.

## Pattern

Ultimately, the structure of `gix::ThreadSafeRepository` suggests a similar 2-tiered structure for Cabaret:

- A thread-safe exterior Cabaret instance which exposes mostly-async user-facing methods, and takes necessary locks before acting.
- A synchronous interior Cabaret instance which exposes mostly-sync helpers that assume you have already taken the necessary locks and are willing to wait for expensive computations.

Most public-facing methods will initialize a `gix::Repository` to work with, which is then shared by interior methods.
