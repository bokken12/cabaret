//! The files a change's workspace has on disk beyond the change's tip: what committing would
//! record, before it is.

use cabaret_lib::Pathspec;
use expect_test::expect;

use super::{
    fixture::{Fixture, id},
    workspace::two_changes,
};

fn workspace_files(fixture: &Fixture, change: &str, pathspecs: &[&str]) -> String {
    let pathspecs: Vec<Pathspec> = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect();
    match fixture.cabaret.workspace_files(&id(change), &pathspecs) {
        Ok(files) => format!("{files:?}"),
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn clean_workspace_has_none() {
    let fixture = two_changes();
    expect!["[]"].assert_eq(&workspace_files(&fixture, "one", &[]));
}

#[test]
fn edits_additions_and_deletions() {
    let fixture = two_changes();
    fixture.write("one.txt", "one, edited\n");
    fixture.write("added.txt", "added\n");
    fixture.delete("main.txt");
    expect![[r#"[Added { path: "added.txt" }, Deleted { path: "main.txt" }, Modified { path: "one.txt" }]"#]]
        .assert_eq(&workspace_files(&fixture, "one", &[]));
}

#[test]
fn renamed() {
    let fixture = two_changes();
    fixture.delete("one.txt");
    fixture.write("moved.txt", "one\n");
    expect![[r#"[Renamed { from: "one.txt", path: "moved.txt" }]"#]].assert_eq(&workspace_files(&fixture, "one", &[]));
}

#[test]
fn staged_files_count_as_on_disk() {
    let fixture = two_changes();
    fixture.stage("staged.txt", "staged\n");
    expect![[r#"[Added { path: "staged.txt" }]"#]].assert_eq(&workspace_files(&fixture, "one", &[]));
}

#[test]
fn ignored_files_are_left_out() {
    let fixture = two_changes();
    fixture.write(".gitignore", "ignored.txt\n");
    fixture.write("ignored.txt", "ignored\n");
    expect![[r#"[Added { path: ".gitignore" }]"#]].assert_eq(&workspace_files(&fixture, "one", &[]));
}

#[test]
fn pathspec_narrows() {
    let fixture = two_changes();
    fixture.write("in.txt", "in\n");
    fixture.write("out.txt", "out\n");
    expect![[r#"[Added { path: "in.txt" }]"#]].assert_eq(&workspace_files(&fixture, "one", &["in.txt"]));
}

#[test]
fn committing_moves_files_into_the_diff() {
    let fixture = two_changes();
    fixture.write("added.txt", "added\n");
    fixture.cabaret.commit(&id("one"), &[]).unwrap();
    expect!["[]"].assert_eq(&workspace_files(&fixture, "one", &[]));
    expect![[r"
        one
          workspace main
          parents main
          owners alice@example.com
          base main
          diff +added.txt +one.txt
    "]]
    .assert_eq(&fixture.describe("one"));
}

#[test]
fn linked_workspace_reports_its_own_files() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    std::fs::write(two.workdir().unwrap().join("two.txt"), "two, edited\n").unwrap();
    fixture.write("one.txt", "one, edited\n");
    expect![[r#"[Modified { path: "two.txt" }]"#]].assert_eq(&workspace_files(&fixture, "two", &[]));
    expect![[r#"[Modified { path: "one.txt" }]"#]].assert_eq(&workspace_files(&fixture, "one", &[]));
}

#[test]
fn change_without_workspace_refuses() {
    let fixture = two_changes();
    expect!["error: two is not checked out in any workspace"].assert_eq(&workspace_files(&fixture, "two", &[]));
}
