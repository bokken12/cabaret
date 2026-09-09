Report unfinished CLI commands without panicking

Replace the six CLI todo!() placeholders with command-specific not-implemented errors. These commands now exit with status 1 through the normal error handler instead of panicking with status 101.

Validation: CLI builds; all six commands were exercised and returned status 1 with a not-implemented message and no panic. Rust formatting passes.