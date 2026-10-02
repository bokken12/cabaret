//! The files a reviewer has left to read: each as the tip differs from the merge of the bases
//! with the tip they last marked it reviewed at.

use cabaret_lib::{Pathspec, RepoPath, safeguard::Allow};
use expect_test::expect;

use super::fixture::{Fixture, alice, id};

fn review_files(fixture: &Fixture, change: &str, pathspecs: &[&str]) -> String {
    let pathspecs: Vec<Pathspec> = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect();
    format!("{:?}", fixture.cabaret.review_files(&id(change), &pathspecs).unwrap())
}

/// Mark `files` of `change` reviewed at its current tip, as the fixture's identity.
fn mark(fixture: &Fixture, change: &str, files: &[&str]) {
    let files: Vec<RepoPath> = files.iter().map(|file| file.parse().unwrap()).collect();
    fixture.cabaret.mark(&id(change), &files, None).unwrap();
}

/// `change` has one commit past its parent `main`, touching `a.txt` and `b.txt`.
fn stacked() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("a.txt", "a\n"), ("b.txt", "b\n")]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("a.txt", "a2\n"), ("b.txt", "b2\n")]);
    fixture
}

#[test]
fn unmarked_files_show_the_whole_diff() {
    let fixture = stacked();
    expect![[r#"[Modified { path: "a.txt" }, Modified { path: "b.txt" }]"#]].assert_eq(&review_files(
        &fixture,
        "change",
        &[],
    ));
}

#[test]
fn marked_files_at_the_tip_drop_out() {
    let fixture = stacked();
    mark(&fixture, "change", &["a.txt"]);
    expect![[r#"[Modified { path: "b.txt" }]"#]].assert_eq(&review_files(&fixture, "change", &[]));
}

#[test]
fn a_file_changed_since_its_mark_shows_only_that() {
    let fixture = stacked();
    mark(&fixture, "change", &["a.txt", "b.txt"]);
    fixture.commit("change", &[("a.txt", "a3\n"), ("c.txt", "c\n")]);
    expect![[r#"[Modified { path: "a.txt" }, Added { path: "c.txt" }]"#]].assert_eq(&review_files(
        &fixture,
        "change",
        &[],
    ));
}

#[test]
fn a_rebase_after_the_mark_leaves_nothing_to_review() {
    let fixture = stacked();
    mark(&fixture, "change", &["a.txt", "b.txt"]);
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture.cabaret.rebase(&id("change"), None, &Allow::default()).unwrap();
    expect!["[]"].assert_eq(&review_files(&fixture, "change", &[]));
}

#[test]
fn a_file_added_since_the_mark_is_added_against_the_reviewed_tip() {
    let fixture = stacked();
    fixture.remove("change", &["b.txt"]);
    mark(&fixture, "change", &["a.txt", "b.txt"]);
    fixture.commit("change", &[("b.txt", "b3\n")]);
    expect![[r#"[Added { path: "b.txt" }]"#]].assert_eq(&review_files(&fixture, "change", &[]));
}

#[test]
fn pathspec_narrows() {
    let fixture = stacked();
    expect![[r#"[Modified { path: "a.txt" }]"#]].assert_eq(&review_files(&fixture, "change", &["a.txt"]));
}

fn markable_files(fixture: &Fixture, change: &str, pathspecs: &[&str]) -> String {
    let pathspecs: Vec<Pathspec> = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect();
    format!("{:?}", fixture.cabaret.markable_files(&id(change), &pathspecs).unwrap())
}

#[test]
fn markable_files_include_reviewed_ones() {
    let fixture = stacked();
    mark(&fixture, "change", &["a.txt"]);
    expect![[r#"{"a.txt", "b.txt"}"#]].assert_eq(&markable_files(&fixture, "change", &[]));
}

#[test]
fn markable_files_include_file_reverted_since_its_mark() {
    let fixture = stacked();
    mark(&fixture, "change", &["a.txt", "b.txt"]);
    fixture.commit("change", &[("a.txt", "a\n")]);
    expect![[r#"{"a.txt", "b.txt"}"#]].assert_eq(&markable_files(&fixture, "change", &[]));
}

#[test]
fn markable_files_match_globs_and_directories() {
    let fixture = stacked();
    fixture.commit("change", &[("dir/c.txt", "c\n"), ("dir/d.md", "d\n")]);
    expect![[r#"{"a.txt", "b.txt", "dir/c.txt"}"#]].assert_eq(&markable_files(&fixture, "change", &["*.txt"]));
    expect![[r#"{"dir/c.txt", "dir/d.md"}"#]].assert_eq(&markable_files(&fixture, "change", &["dir"]));
}

#[test]
fn markable_files_matching_nothing_is_empty() {
    let fixture = stacked();
    expect!["{}"].assert_eq(&markable_files(&fixture, "change", &["missing.txt"]));
}
