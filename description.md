Render changed files as a compact folder tree

Diff, review, and uncommitted pages group files by destination path, with alphabetically ordered siblings and foldable folder headings. Single-child paths collapse onto one line, including lone files. The tree uses the home DAG markers: ○ for files, ◌ for contextual folders, and ├─, ╰─, and │ for branches and continuations.

Renames and copies appear once at their destination with a muted source annotation; same-folder sources use only the old filename. Deleted files stay at their old path. File rows preserve their original diff targets and selection behavior. Folder headings are structural and do not select hidden descendants.

Validation: all 12 page tests pass with updated marker snapshots, including nested folds and branch continuations. Formatting and whitespace checks pass. Earlier full validation passed 150 library tests, with two existing review-metadata snapshot failures reproduced on main. All-feature cargo check and Clippy completed with existing warnings; all-feature test linking failed on unresolved Node N-API symbols. Interactive VS Code behavior was not exercised.