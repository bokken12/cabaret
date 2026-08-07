# Stack

Most of the tech stack is dictated by the need to efficiently interact with git. Especially on larger monorepos, shelling out to subprocesses is untenable performance-wise.

In this aspect, Rust's ecosystem has a distinct advantage due to [gitoxide](https://github.com/gitoxidelabs/gitoxide), which notably powers JJ, an app with very similar structure/requirements to Cabaret.

Cabaret will also need a thin web/UI layer in TypeScript/Node to power its VSCode extension (and future web UI), but will attempt to keep its main logic in Rust. This will rely heavily on Shiki to unify formatting with VSCode.
