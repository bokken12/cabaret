Render changed files as a compact folder tree

Diff, review, and uncommitted pages now group files by destination path, with alphabetically ordered siblings and foldable folder headings. Single-child paths collapse onto one line, including lone files. Renames and copies appear once at their destination with a muted source annotation; same-folder sources use only the old filename. Deleted files stay at their old path.

File rows preserve their original diff targets and selection behavior. Folder headings are structural and do not select hidden descendants. Tests cover all three views, empty and single-file lists, nested folds, source annotations, and a deleted file replaced by a directory.