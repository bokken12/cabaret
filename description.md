Render changed files as a compact folder tree

Diff, review, and uncommitted pages group files by destination path, with alphabetically ordered siblings and foldable folder headings. Single-child paths collapse onto one line. Markers match the home DAG: ○ for files, ◌ for contextual folders, and ├─, ╰─, and │ for branches and continuations.

Renames and copies appear once at their destination with muted source annotations; same-folder sources use the old filename. Deleted files stay at their old path. File targets and selection behavior are preserved; folder headings do not select hidden descendants.

FileTree lives in lib/src/file_tree.rs and handles generic values independently of ChangedFile. Callers supply file-row styling and targets. Direct renderer tests cover empty and compact trees, nested branch continuations and folds, Unicode paths, and multiple entries at a path that is also a directory. Page tests retain coverage of all three changed-file views and rename/copy behavior.

Validation: all 39 unit tests pass. Clippy with all targets and features completes with existing warnings and none in file_tree.rs; formatting and whitespace checks pass. Earlier full validation found two review-metadata snapshot failures reproduced on main, and all-feature test linking failed on unresolved Node N-API symbols. Interactive VS Code behavior was not exercised.