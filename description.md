Store::transact is generic over its closure's error, so a transaction that fails for any reason records nothing, and safeguarded actions fail with Refusable<S>: Refused(NEVec<S>) or Failed(Error). Replaces transact_or_abort and its doubly nested results; Allow::check refuses with ? instead of returning Ok(Err(..)).

Safeguarded Cabaret methods now return Result<T, Refusable<S>>; the CLI's refusal() passes Failed through, and node.rs splits it back into its Done/Refused outcomes.
