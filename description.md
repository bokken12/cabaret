Bump dependencies

Bumps the Rust and pnpm catalog dependencies to their latest releases, including the major versions gix 0.91, jiff 1.0, and @vscode/vsce 4. @types/node stays on 22.x and @types/vscode stays pinned to engines.vscode. rust-version moves to the latest stable, 1.100.0.

Code changes for the API breaks:
- gix 0.91 bare clones now copy origin's branches straight to local branches and write no origin/HEAD. init now sets the remote-tracking refspec itself and writes origin/HEAD and the default branch, as before.
- gix's merge_base returns None for unrelated histories. is_predecessor treats that as false, and bases reports it as an error.
- gix lock and index writes take SharedPermissions; Umask keeps the previous behavior.
- gix path conversions and worktree ids are now fallible, so they propagate errors.
- jiff renames Zoned to ZonedDateTime.

gix-merge's rewritten text driver gives the virtual merge base of conflicting parents a different commit id; the conflict contents are unchanged.