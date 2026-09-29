//! Both sides of each file a change's view diffs, as of the tip they were read at.

use cabaret_lib::{DiffView, FileVersion, Pathspec, RepoPath};
use expect_test::expect;

use super::{
    fixture::{Fixture, alice, id},
    workspace::two_changes,
};

fn view_diff(fixture: &Fixture, change: &str, view: DiffView, pathspecs: &[&str]) -> String {
    let pathspecs: Vec<Pathspec> = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect();
    let diff = fixture.cabaret.view_diff(&id(change), view, &pathspecs).unwrap();
    assert_eq!(diff.tip, fixture.tip(change));
    let side = |version: &Option<FileVersion>| match version {
        Some(FileVersion { mode, data }) => format!("{mode:o} {data:?}"),
        None => "absent".to_owned(),
    };
    diff.files
        .iter()
        .map(|file| format!("{:?}: {} -> {}\n", file.file, side(&file.before), side(&file.after)))
        .collect()
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
fn modified_added_and_deleted() {
    let fixture =
        edited(&[("file.txt", "before\n"), ("old.txt", "old\n")], &[("file.txt", "after\n"), ("new.txt", "new\n")]);
    fixture.remove("change", &["old.txt"]);
    expect![[r#"
        Modified { path: "file.txt" }: 100644 "before\n" -> 100644 "after\n"
        Added { path: "new.txt" }: absent -> 100644 "new\n"
        Deleted { path: "old.txt" }: 100644 "old\n" -> absent
    "#]]
    .assert_eq(&view_diff(&fixture, "change", DiffView::Diff, &["*"]));
}

#[test]
fn renamed_reads_each_side_at_its_own_path() {
    let fixture = edited(&[("old.txt", "1\n2\n3\n4\n")], &[("new.txt", "1\n2\n3\nfour\n")]);
    fixture.remove("change", &["old.txt"]);
    expect![[r#"
        Renamed { from: "old.txt", path: "new.txt" }: 100644 "1\n2\n3\n4\n" -> 100644 "1\n2\n3\nfour\n"
    "#]]
    .assert_eq(&view_diff(&fixture, "change", DiffView::Diff, &["*"]));
}

#[test]
fn pathspecs_narrow() {
    let fixture = edited(&[], &[("a.txt", "a\n"), ("b.txt", "b\n")]);
    expect![[r#"
        Added { path: "b.txt" }: absent -> 100644 "b\n"
    "#]]
    .assert_eq(&view_diff(&fixture, "change", DiffView::Diff, &["b.txt"]));
    expect![[r#""#]].assert_eq(&view_diff(&fixture, "change", DiffView::Diff, &["c.txt"]));
}

#[test]
fn review_reads_each_file_from_where_it_was_marked() {
    let fixture = edited(&[("a.txt", "a\n"), ("b.txt", "b\n")], &[("a.txt", "a2\n"), ("b.txt", "b2\n")]);
    fixture.cabaret.mark(&id("change"), &["a.txt".parse::<RepoPath>().unwrap()], None).unwrap();
    fixture.commit("change", &[("a.txt", "a3\n"), ("b.txt", "b3\n")]);
    expect![[r#"
        Modified { path: "a.txt" }: 100644 "a2\n" -> 100644 "a3\n"
        Modified { path: "b.txt" }: 100644 "b\n" -> 100644 "b3\n"
    "#]]
    .assert_eq(&view_diff(&fixture, "change", DiffView::Review, &["*"]));
}

#[test]
fn workspace_reads_disk_against_tip() {
    let fixture = two_changes();
    fixture.write("one.txt", "one, edited\n");
    expect![[r#"
        Modified { path: "one.txt" }: 100644 "one\n" -> 100644 "one, edited\n"
    "#]]
    .assert_eq(&view_diff(&fixture, "one", DiffView::Workspace, &["*"]));
}
