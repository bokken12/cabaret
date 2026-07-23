# Performance

## Monorepos & Organizations

Cabaret aims to support large monorepos with many files, as well as large organizations with many contributors and active changes. This means it is mandatory to consider performance and not test only with minimal examples.

## Subprocesses & Batching

Because Cabaret is built on top of `git`, most of its expensive operations do not actually live within its own code. In addition to simply avoiding asking `git` for expensive things, one of the main levers available to Cabaret is to minimize the number of spawned subprocesses via long-running sessions or batching.

## Obligations & Home

One particular performance pain point for Cabaret is in rendering the "home" page which notably shows all of a user's outstanding review. Since unlike `CODEOWNERS`, Cabaret's obligations are encoded throughout many files in the tree, and we must read all of them for each change to determine whether a user must review it, this can be very expensive. For operations here we must be particularly careful, e.g. aggressively pruning changes which the current user could not be reviewing before reading through its contents.

## Cached Readings

Everything a page derives about a change — its summary, what review it asks of whom — is a pure function of refs (the change's log, its branch, origin's copies, its parent's) and of immutable objects those refs reach. Pages therefore cache each change's reading persistently, keyed by exactly the reads its computation made, and validate the whole cache against a single batched snapshot of every ref. A view of a large repository then recomputes only the changes something actually moved, and an organization's worth of open changes costs a view almost nothing while they sit unchanged.
