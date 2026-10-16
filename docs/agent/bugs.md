# Bugs

Bugs agents have noticed but not fixed, recorded so they can be picked up later. Remove an entry once it is fixed.

## Landing After a Conflicted Rebase Lands the Conflict Markers

`Cabaret::land` says conflicts are refused rather than landed, but it only checks for conflicts produced by the land merge itself. After a rebase that hits conflicts, the child's tip is a merge commit holding conflict markers, and it already contains the parent's tip. Landing the child is then a fast-forward. `Branch::merge` reports a fast-forward as having no conflicts, so the markers land in the parent.

Reproduce: `main` has `greeting.txt` as `hello`. `child` changes it to `hi`, then `main` changes it to `hey`. Rebase `child`, which commits the conflict markers, then land it. The land succeeds, and `main`'s `greeting.txt` is the conflicted text.

Possible fix: have `land` refuse when `Branch::conflicted_files` finds markers in the child.

## Fetching From a Local-Path Origin Dies of SIGPIPE

`cab fetch` exits with status 141 and no output when origin is a local path or `file://` URL, before pushing anything. `cab init --from` a local path dies the same way, leaving only `.bare`. The CLI restores the default SIGPIPE disposition in `main`, and gix's local transport writes to the `git-upload-pack` child it spawns after that child has closed its end. Network origins (`git://`, `https://`) are unaffected; serving the same bare repository with `git daemon` works.

Reproduce: `git init --bare origin.git`, push a `main` to it, clone it, create a change, then `cab fetch` in the clone. It exits 141 and origin gains no `refs/cabaret/*`.

Possible fix: leave SIGPIPE ignored and have the CLI exit quietly when writing to stdout fails with `BrokenPipe`, ignore SIGPIPE while fetching, or find which write in the file transport needs the child kept open.
