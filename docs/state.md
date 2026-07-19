# State

For each change, a user's review state can be represented as a map from file name to: (base hash, tip hash, timestamp) representing the time at which they reviewed the base -> tip diff.

There are a number of restrictions on how state can be stored:

- State must live entirely within git, without external servers or local storage.
- State must never produce any conflicts that are surfaced to the user.

These two goals are conflicting, but can be unified by a log of associative operations merged by union. Cabaret performs the union itself when syncing (no `.gitattributes` setup): the merged log is the union of the two logs' entries, deduplicated by serialized line and ordered by timestamp then serialized line. Being a function of the entry sets alone, the merge is conflict-free and every machine converges on byte-identical logs.

Our principle operation is conditional `set` on a single file's review state, with associativity coming from taking the value with the latest timestamp. Reads break equal-timestamp ties on the serialized entry, never on log position, so machines agree on the winner.

The lack of any log will be treated as equivalent to an empty log so that there is no separate initialization step required.

Each change stores its log under a dedicated ref (`refs/cabaret/log/<change>`) with name mirroring the name of the branch it tracks. Syncing fetches the remote's logs, merges each into the local ref, and pushes the result without forcing, so a concurrent push is never overwritten — it fails and merges on retry. In the future we may swap to a UUID-based system to better permit distributed renaming, but this will simplify our system for now.
