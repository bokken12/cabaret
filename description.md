Remove `SetDescription` from `LogAction`, now that no log in this repository carries one.

Every `refs/cabaret/changes/*` whose log had `set-description` entries was rewritten by a one-off script: the entries were dropped from `log.jsonl` and the latest one's text became `description.md`, committed on top of the previous metadata commit so the history stays. The legacy fold in `Metadata::apply`, its test, and the fixture helper that forged old-format logs go with the variant.
