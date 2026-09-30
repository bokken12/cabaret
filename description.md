Decide in the lib that a blank description clears

The CLI and the extension each cleared a whitespace-only description themselves, while `set_description` cleared only an empty one, so a lib or napi caller could store whitespace. `set_description` now takes the text and clears on blank, and both frontends pass what they were given.