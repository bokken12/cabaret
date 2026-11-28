Remove transaction locks when the node host exits

An extension host that exits mid-transaction, as on reload or reinstall, left its lock files behind, held; a stranded packed-refs.lock then failed every later ref edit with "could not lock packed refs". The native module now registers an atexit hook that removes this process's gix tempfiles, which hold both gix's ref locks and cabaret's own, as the CLI already does on Ctrl-C.

Checked by hand under plain node: a land blocked on a held branch lock, then process.exit(0), leaves its metadata lock behind without this and removes it with it. Not yet checked under VS Code's extension host.