Unprefix change names in the VS Code test fixture

The fixture in `vscode/.vscode-test.mjs` creates `feature`, but cabaret now dates new change names by default, so the change came out as `<date>-feature`. Loading the config then failed with "The reference 'refs/heads/feature' did not exist", so no integration test ran. The fixture now sets `cabaret.prefix` to empty, like the lib test fixture does.

Unrelated, and not fixed here: from a workspace with a long path (e.g. `~/src/cabaret/2026-09-27-vscode-test-prefix`), VS Code's IPC socket under `vscode/.vscode-test/user-data` goes over macOS's 103-character limit and startup fails with `listen EINVAL`. macOS's temp dir is too long to move it to as well.