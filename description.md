Settings in git config

A new `cabaret-config` crate holds local state, the user's preferences, kept in git config
beside git's own. A `Setting` is a typed value stored under a fixed key: it parses on read, so
a hand-edited bad value fails loudly rather than flowing through. Writes go to the
repository's local config by default, as `git config` does, under the lock git itself takes.

`cab config <setting> show|set|unset [--global]` edits one, starting with `identity` (git's
user.email). `Cabaret` wraps the crate so it rereads config after writing it.