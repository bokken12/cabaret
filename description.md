Settings in git config

A `Setting` is a typed value stored in git config under a fixed key: it parses on read, so a
hand-edited bad value fails loudly rather than flowing through. `cab config <setting>
show|set|unset [--global]` edits one, starting with `identity` (git's user.email).

Writes go to the repository's local config by default, as `git config` does.