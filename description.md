Currently, after a change is landed, it shows as "status: archived", often losing its diff.

This is not an ideal user experience. We'd like it to say "status: landed", and for its diff to preserve the version of the change that was landed.

This will probably require adding to the log, so that we record land events, and when we do so we include info about the base / tip (maybe even parent?) at time of land.

Note that none of this applies to "permanent" features which should still show "open". We can worry about how to view their historical lands later.

NOTE ON DEVELOPMENT:

This feature should likely be made in a couple parts using Cabaret's change DAG and stacking functionality. Consider e.g. first making a change which just has the log info, before writing the child change which updates the UI. If uncertain about which direction is better, consider making sibling changes which demonstrate the possibilities.