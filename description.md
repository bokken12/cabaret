Witness a session exiting while sessions are listed

Claude Code deletes `sessions/<pid>.json` when a session exits. If that happens between listing the directory and opening the file, the open fails and so does the whole `sessions_in`. The test stands in for the race with a dangling symlink and records the failure with a TODO; the child change fixes it.