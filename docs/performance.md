# Performance

## Monorepos & Organizations

Cabaret aims to support large monorepos with many files, as well as large organizations with many contributors and active changes. This means it is mandatory to consider performance and not test only with minimal examples.

## Gix

Cabaret aims to avoid expensive subprocess spawning by using the native-rust `gix` crate for as many of its operations as possible.

## Caching & Invalidation

Many of Cabaret's most expensive operations involve reading over some ref's tree. These include reading change logs to compute change state, and even more severe is recursively reading obligations files to compute review obligations.

After performing this sort of an operation, Cabaret can typically cache the result for reuse, recomputing only if it sees the ref has moved.

## Home

By far Cabaret's most expensive page to render is its home page, since it attempts to render a representation of all changes relevant to a user (those they own, must review, or have checked out). This can require computing state for all changes to see which are relevant.

Cabaret is willing to do this sometimes lossily: missing out on spotting new changes to be attentive of until the appropriate fetch omputation has been performed (in the background in most UIs).
