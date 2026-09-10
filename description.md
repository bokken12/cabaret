Render changed files as a compact folder tree

Diff, review, and uncommitted pages group files by destination path, with alphabetically ordered siblings and foldable folder headings. Single-child paths collapse onto one line. Markers match the home DAG: ○ for files, ◌ for contextual folders, and ├─, ╰─, and │ for branches and continuations.

Renames and copies appear once at their destination with muted source annotations; same-folder sources use the old filename. Deleted files stay at their old path. File targets and selection behavior are preserved; folder headings do not select hidden descendants.

FileTree lives in lib/src/file_tree.rs and accepts ChangedFile records directly. It owns tree layout, status styling, and source annotations; the outer page layer supplies Cabaret navigation targets and empty-state messages. Direct rendering tests use changed files without change IDs or repository setup, illustrating compact paths, nested branches and folds, Unicode paths, file-to-directory replacement, and mixed additions, deletions, modifications, renames, and copies. Page tests retain navigation coverage for all three views.

Validation: all 40 unit tests pass. Formatting and whitespace checks pass. Earlier full validation found two review-metadata snapshot failures reproduced on main, and all-feature test linking failed on unresolved Node N-API symbols. Interactive VS Code behavior was not exercised.