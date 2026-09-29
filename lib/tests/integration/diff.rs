//! A change's diffs as `git diff` shows them, headed by the change and the tip they end at.

use cabaret_lib::{DiffView, Pathspec, RepoPath};
use expect_test::expect;

use super::{
    fixture::{Fixture, alice, id},
    workspace::two_changes,
};

fn diff(fixture: &Fixture, change: &str, view: DiffView, pathspecs: &[&str]) -> String {
    let pathspecs: Vec<Pathspec> = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect();
    let diff = fixture.cabaret.diff(&id(change), view, &pathspecs).unwrap();
    String::from_utf8(diff.into()).unwrap().replace(&fixture.tip(change).to_string(), "<tip>")
}

/// `change` makes `edits` on top of a parent `main` holding `files`.
fn edited(files: &[(&str, &str)], edits: &[(&str, &str)]) -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", files);
    fixture.create("change", "main", &alice());
    fixture.commit("change", edits);
    fixture
}

#[test]
fn modified_with_context() {
    let fixture =
        edited(&[("file.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n")], &[("file.txt", "1\n2\n3\n4\nfive\n6\n7\n8\n9\n")]);
    expect![[r#"
        change · changed files at <tip>

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
    .assert_eq(&diff(&fixture, "change", DiffView::Diff, &["*"]));
}

#[test]
fn added_and_deleted() {
    let fixture = edited(&[("old.txt", "old\n")], &[("new.txt", "new\n")]);
    fixture.remove("change", &["old.txt"]);
    expect![[r#"
        change · changed files at <tip>

        diff --git a/new.txt b/new.txt
        new file mode 100644
        --- /dev/null
        +++ b/new.txt
        @@ -1,0 +1,1 @@
        +new
        diff --git a/old.txt b/old.txt
        deleted file mode 100644
        --- a/old.txt
        +++ /dev/null
        @@ -1,1 +1,0 @@
        -old
    "#]]
    .assert_eq(&diff(&fixture, "change", DiffView::Diff, &["*"]));
}

#[test]
fn pure_rename_has_no_hunks() {
    let fixture = edited(&[("old.txt", "same\n")], &[("new.txt", "same\n")]);
    fixture.remove("change", &["old.txt"]);
    expect![[r#"
        change · changed files at <tip>

        diff --git a/old.txt b/new.txt
        rename from old.txt
        rename to new.txt
    "#]]
    .assert_eq(&diff(&fixture, "change", DiffView::Diff, &["*"]));
}

#[test]
fn missing_final_newline_marked() {
    let fixture = edited(&[("file.txt", "line\n")], &[("file.txt", "line")]);
    expect![[r#"
        change · changed files at <tip>

        diff --git a/file.txt b/file.txt
        --- a/file.txt
        +++ b/file.txt
        @@ -1,1 +1,1 @@
        -line
        +line
        \ No newline at end of file
    "#]]
    .assert_eq(&diff(&fixture, "change", DiffView::Diff, &["*"]));
}

#[test]
fn binary_files_not_shown() {
    let fixture = edited(&[("file.bin", "a\0b")], &[("file.bin", "a\0c")]);
    expect![[r#"
        change · changed files at <tip>

        diff --git a/file.bin b/file.bin
        Binary files a/file.bin and b/file.bin differ
    "#]]
    .assert_eq(&diff(&fixture, "change", DiffView::Diff, &["*"]));
}

#[test]
fn pathspecs_narrow() {
    let fixture = edited(&[], &[("a.txt", "a\n"), ("b.txt", "b\n")]);
    expect![[r#"
        change · changed files at <tip>

        diff --git a/b.txt b/b.txt
        new file mode 100644
        --- /dev/null
        +++ b/b.txt
        @@ -1,0 +1,1 @@
        +b
    "#]]
    .assert_eq(&diff(&fixture, "change", DiffView::Diff, &["b.txt"]));
    expect![[r#"
        change · changed files at <tip>

        no changed files
    "#]]
    .assert_eq(&diff(&fixture, "change", DiffView::Diff, &["c.txt"]));
}

#[test]
fn review_diffs_each_file_from_where_it_was_marked() {
    let fixture = edited(&[("a.txt", "a\n"), ("b.txt", "b\n")], &[("a.txt", "a2\n"), ("b.txt", "b2\n")]);
    fixture.cabaret.mark(&id("change"), &["a.txt".parse::<RepoPath>().unwrap()], None).unwrap();
    fixture.commit("change", &[("a.txt", "a3\n"), ("b.txt", "b3\n")]);
    expect![[r#"
        change · unreviewed files at <tip>

        diff --git a/a.txt b/a.txt
        --- a/a.txt
        +++ b/a.txt
        @@ -1,1 +1,1 @@
        -a2
        +a3
        diff --git a/b.txt b/b.txt
        --- a/b.txt
        +++ b/b.txt
        @@ -1,1 +1,1 @@
        -b
        +b3
    "#]]
    .assert_eq(&diff(&fixture, "change", DiffView::Review, &["*"]));
}

#[test]
fn workspace_diffs_disk_from_tip() {
    let fixture = two_changes();
    fixture.write("one.txt", "one, edited\n");
    expect![[r#"
        one · uncommitted files at <tip>

        diff --git a/one.txt b/one.txt
        --- a/one.txt
        +++ b/one.txt
        @@ -1,1 +1,1 @@
        -one
        +one, edited
    "#]]
    .assert_eq(&diff(&fixture, "one", DiffView::Workspace, &["*"]));
}
