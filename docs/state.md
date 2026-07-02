# State

For each change, a user's review state can be represented as a map from file name to: (base hash, tip hash, timestamp) representing the time at which they reviewed the base -> tip diff.

There are a number of restrictions on how state can be stored:

- State must live entirely within git, without external servers or local storage.
- State must never produce any conflicts that are surfaced to the user.

These two goals are conflicting, but can be unified by storing state with an automated merge strategy in `.gitattributes`. To minimize setup, we prefer the built-in `union` strategy with a log of associative operations.

Our principle operation is conditional `set` on a single file's review state, with associativity coming from taking the value with the latest timestamp.

The lack of any log will be treated as equivalent to an empty log so that there is no separate initialization step required.

Each change will store its log under a dedicated ref with name mirroring the name of the branch it tracks. In the future we may swap to a UUID-based system to better permit distributed renaming, but this will simplify our system for now.


