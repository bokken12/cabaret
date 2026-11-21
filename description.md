`land_safeguards` used to be pulled out so it could be precomputed without running the transaction. This is no longer necessary, so it can be inlined and possibly simplified.

This should be possible with other safeguard methods as well.