Mark --parent with --child unreachable in create

clap's `conflicts_with` already rejects the pair, so the arm is `unreachable!` like `Diff`'s rather than a second error message.