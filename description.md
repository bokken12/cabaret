In a new config.rs (in either cabaret-transaction, cabaret-lib, or both), create the basic framework for cabaret config management.

Initial config is just "identity": previous clients of identity swap to taking it from config methods, and the config CLI command is wired up so we can do `cab config identity set ...`.

Config should be extensible for more types of fields with more interesting validation: e.g. fields which must be ints or be selected from a list of options, but those need nota be supported right now