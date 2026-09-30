//! Diffs rendered as `git diff` shows them.

use cabaret_cli::diff::unified;
use cabaret_lib::{
    ChangedFile, FileVersion,
    gix::objs::tree::{EntryKind, EntryMode},
};
use expect_test::expect;

fn version(data: &str) -> Option<FileVersion> { Some(FileVersion { mode: EntryKind::Blob.into(), data: data.into() }) }

fn render(file: ChangedFile, before: Option<FileVersion>, after: Option<FileVersion>) -> String {
    String::from_utf8(unified(&file, before.as_ref(), after.as_ref()).into()).unwrap()
}

fn modified() -> ChangedFile { ChangedFile::Modified { path: "file.txt".parse().unwrap() } }

#[test]
fn modified_with_context() {
    expect![[r#"
        diff --git a/file.txt b/file.txt
        --- a/file.txt
        +++ b/file.txt
        @@ -2,7 +2,7 @@
         2
         3
         4
        -5
        +five
         6
         7
         8
    "#]]
    .assert_eq(&render(modified(), version("1\n2\n3\n4\n5\n6\n7\n8\n9\n"), version("1\n2\n3\n4\nfive\n6\n7\n8\n9\n")));
}

#[test]
fn added() {
    expect![[r#"
        diff --git a/new.txt b/new.txt
        new file mode 100644
        --- /dev/null
        +++ b/new.txt
        @@ -1,0 +1,1 @@
        +new
    "#]]
    .assert_eq(&render(ChangedFile::Added { path: "new.txt".parse().unwrap() }, None, version("new\n")));
}

#[test]
fn deleted() {
    expect![[r#"
        diff --git a/old.txt b/old.txt
        deleted file mode 100644
        --- a/old.txt
        +++ /dev/null
        @@ -1,1 +1,0 @@
        -old
    "#]]
    .assert_eq(&render(ChangedFile::Deleted { path: "old.txt".parse().unwrap() }, version("old\n"), None));
}

#[test]
fn pure_rename_has_no_hunks() {
    let file = ChangedFile::Renamed { from: "old.txt".parse().unwrap(), path: "new.txt".parse().unwrap() };
    expect![[r#"
        diff --git a/old.txt b/new.txt
        rename from old.txt
        rename to new.txt
    "#]]
    .assert_eq(&render(file, version("same\n"), version("same\n")));
}

#[test]
fn copy_with_edit() {
    let file = ChangedFile::Copied { from: "original.txt".parse().unwrap(), path: "copy.txt".parse().unwrap() };
    expect![[r#"
        diff --git a/original.txt b/copy.txt
        copy from original.txt
        copy to copy.txt
        --- a/original.txt
        +++ b/copy.txt
        @@ -1,1 +1,2 @@
         same
        +more
    "#]]
    .assert_eq(&render(file, version("same\n"), version("same\nmore\n")));
}

#[test]
fn mode_change() {
    let executable = Some(FileVersion { mode: EntryMode::from(EntryKind::BlobExecutable), data: "run\n".into() });
    expect![[r#"
        diff --git a/file.txt b/file.txt
        old mode 100644
        new mode 100755
    "#]]
    .assert_eq(&render(modified(), version("run\n"), executable));
}

#[test]
fn missing_final_newline_marked() {
    expect![[r#"
        diff --git a/file.txt b/file.txt
        --- a/file.txt
        +++ b/file.txt
        @@ -1,1 +1,1 @@
        -line
        +line
        \ No newline at end of file
    "#]]
    .assert_eq(&render(modified(), version("line\n"), version("line")));
}

#[test]
fn binary_files_not_shown() {
    expect![[r#"
        diff --git a/file.txt b/file.txt
        Binary files a/file.txt and b/file.txt differ
    "#]]
    .assert_eq(&render(modified(), version("a\0b"), version("a\0c")));
}
