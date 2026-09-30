Keep VS Code test user data under a short temp root

VS Code's IPC socket lives in its user data dir, and macOS caps socket paths at 103 bytes, so integration tests failed with `listen EINVAL` from any checkout with a long path. The test root moves from $TMPDIR, itself too long on macOS, to /tmp, and VS Code's user data goes inside it, fresh each run.