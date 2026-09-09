Render changed files as a compact folder tree

Diff, review, and uncommitted pages now group files by destination path, with alphabetically ordered siblings and foldable folder headings. Single-child paths collapse onto one line, including lone files. Renames and copies appear once at their destination with a muted source annotation; same-folder sources use only the old filename. Deleted files stay at their old path.

File rows preserve their original diff targets and selection behavior. Folder headings are structural and do not select hidden descendants. Tests cover all three views, empty and single-file lists, nested folds, source annotations, and a deleted file replaced by a directory.

Validation: all 12 page tests pass. The workspace run passed 150 library tests and failed two existing review-metadata snapshots (later_mark_replaces_earlier_one and mark_defaults_to_bases_and_tip), both reproduced on main. All-feature cargo check and Clippy complete; Clippy reports existing warnings. Rust formatting and whitespace checks pass. All-feature test linking fails on unresolved Node N-API symbols. Interactive VS Code behavior was not exercised.