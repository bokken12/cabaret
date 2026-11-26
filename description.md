Return refusals in one shape from the node bindings

Every binding that safeguards can refuse returns its result or a `Refused` holding the safeguards, through napi's `Either`, in place of an outcome enum per result type (`Attempt`, `Created`, `Committed`, `Landed`, `Rebased`). The extension's `despite` tells the two apart and hands back what the action did.