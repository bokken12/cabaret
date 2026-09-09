//! The files a reviewer has left to read: each as the tip differs from the merge of the bases
//! with the tip they last marked it reviewed at.

use cabaret_lib::{Pathspec, RepoPath};
use expect_test::expect;

use super::fixture::{Fixture, alice, id, short};

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
fn review_base_merges_bases_with_the_reviewed_tip() {
    let fixture = stacked();
    mark(&fixture, "change", &["a.txt"]);
    let reviewed = fixture.tip("change");
    fixture.commit("change", &[("a.txt", "a3\n")]);
    let base = |path: &str| short(fixture.cabaret.review_base(&id("change"), &path.parse().unwrap()).unwrap().unwrap());
    expect!["REVIEWED"].assert_eq(&base("a.txt").replace(&short(reviewed), "REVIEWED"));
    expect!["BASE"].assert_eq(&base("b.txt").replace(&short(fixture.tip("main")), "BASE"));
}

#[test]
fn a_rebase_after_the_mark_leaves_nothing_to_review() {
    let fixture = stacked();
    mark(&fixture, "change", &["a.txt", "b.txt"]);
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture.cabaret.rebase(&id("change"), None).unwrap();
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
