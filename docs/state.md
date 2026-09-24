# State

## Logs

Cabaret has central server/coordinator, and so all shared state must live within git. However, shared git state is liable to produce conflicts, and Cabaret seeks never to expose to the user conflicts in its internal state. This means any shared state must have an automatic merging strategy.

The most common such strategy is an append-only log, where the operations are associative and we can merge via union. The canonical example of this is each change's log, which orders actions by the commit graph of which writes saw which, falling back to "last write wins" by commit time between writes that did not see each other.

However there can be some exceptions, such as change descriptions, which simply permit conflicts as valid state, and therefore can also auto-resolve.

## Configs

In addition to shared state, Cabaret sometimes has local state: primarily configs recording user preferences. Again we prefer to piggyback on existing stores: putting data in the git or vscode configs as appropriate.

For each change, a user's review state can be represented as a map from file name to: (base hash, tip hash, timestamp) representing the time at which they reviewed the base -> tip diff.
