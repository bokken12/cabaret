//! The files a change presents: its tip's tree against its base's, with renames detected and
//! pathspecs narrowing the result.

use cabaret_lib::types::Pathspec;
use expect_test::expect;

use super::fixture::{Fixture, alice, id};

fn changed_files(fixture: &Fixture, change: &str, pathspecs: &[&str]) -> String {
    let pathspecs: Vec<Pathspec> = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect();
    format!("{:?}", fixture.cabaret.changed_files(&id(change), &pathspecs).unwrap())
}

#[test]
fn added() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("new.txt", "new\n")]);
    expect![[r#"[Added { path: "new.txt" }]"#]].assert_eq(&changed_files(&fixture, "change", &[]));
}

#[test]
fn modified() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.txt", "before\n")]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("file.txt", "after\n")]);
    expect![[r#"[Modified { path: "file.txt" }]"#]].assert_eq(&changed_files(&fixture, "change", &[]));
}

#[test]
fn deleted() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.txt", "file\n")]);
    fixture.create("change", "main", &alice());
    fixture.remove("change", &["file.txt"]);
    expect![[r#"[Deleted { path: "file.txt" }]"#]].assert_eq(&changed_files(&fixture, "change", &[]));
}

#[test]
fn renamed() {
    let fixture = Fixture::new();
    fixture.root("main", &[("old.txt", "same\n")]);
    fixture.create("change", "main", &alice());
    fixture.remove("change", &["old.txt"]);
    fixture.commit("change", &[("new.txt", "same\n")]);
    expect![[r#"[Renamed { from: "old.txt", path: "new.txt" }]"#]].assert_eq(&changed_files(&fixture, "change", &[]));
}

#[test]
fn copy_reported_as_added() {
    let fixture = Fixture::new();
    fixture.root("main", &[("original.txt", "same\n")]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("copy.txt", "same\n")]);
    expect![[r#"[Added { path: "copy.txt" }]"#]].assert_eq(&changed_files(&fixture, "change", &[]));
}

#[test]
fn renamed_directory_reports_its_files() {
    let fixture = Fixture::new();
    fixture.root("main", &[("old/a.txt", "a\n"), ("old/b.txt", "b\n")]);
    fixture.create("change", "main", &alice());
    fixture.remove("change", &["old/a.txt", "old/b.txt"]);
    fixture.commit("change", &[("new/a.txt", "a\n"), ("new/b.txt", "b\n")]);
    expect![[
        r#"[Renamed { from: "old/b.txt", path: "new/b.txt" }, Renamed { from: "old/a.txt", path: "new/a.txt" }]"#
    ]]
    .assert_eq(&changed_files(&fixture, "change", &[]));
}

#[test]
fn empty_change_has_none() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.txt", "file\n")]);
    fixture.create("change", "main", &alice());
    expect!["[]"].assert_eq(&changed_files(&fixture, "change", &[]));
}

#[test]
fn pathspec_narrows() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("src/lib.rs", "\n"), ("docs/guide.md", "\n")]);
    expect![[r#"[Added { path: "src/lib.rs" }]"#]].assert_eq(&changed_files(&fixture, "change", &["src"]));
}

#[test]
fn pathspec_matches_either_side_of_rename() {
    let fixture = Fixture::new();
    fixture.root("main", &[("old.txt", "same\n")]);
    fixture.create("change", "main", &alice());
    fixture.remove("change", &["old.txt"]);
    fixture.commit("change", &[("new.txt", "same\n")]);
    expect![[r#"[Renamed { from: "old.txt", path: "new.txt" }]"#]].assert_eq(&changed_files(
        &fixture,
        "change",
        &["old.txt"],
    ));
}

#[test]
fn parent_commits_after_fork_excluded() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.create("child", "parent", &alice());
    fixture.commit("child", &[("child.txt", "child\n")]);
    fixture.commit("parent", &[("parent.txt", "parent\n")]);
    expect![[r#"[Added { path: "child.txt" }]"#]].assert_eq(&changed_files(&fixture, "child", &[]));
}
