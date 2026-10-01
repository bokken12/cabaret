Implement `cab fetch`: fetch origin's branches (into refs/remotes/origin/*) and change logs (into refs/cabaret/remotes/origin/changes/*), merge each fetched log into the local one, then push every local log back with `git push`, since gix cannot push.

A log merge fast-forwards when one side has seen the other, else writes a merge commit with no actions of its own (folding already orders both sides) whose description is the two 3-way merged, conflicts kept as diff3 text labelled by each head's author. It runs under the change's metadata lock as `Store::merge_log`. docs/log.md describes syncing.

Branches are tracking-only for now; syncing local branches is a TODO in `Cabaret::fetch`.