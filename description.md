Skip sessions that exit while being listed

A registry entry that disappears between listing `sessions/` and opening it belongs to a session that just exited, so it is skipped rather than failing the listing.