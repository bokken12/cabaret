//! Review marks: which range of a change each user has read, per file.

use std::fmt::Write as _;

use cabaret_lib::Pathspec;
use expect_test::expect;

use super::fixture::{Fixture, alice, id, short};

/// Every mark as `user file revision`, with short hashes.
fn review(fixture: &Fixture, change: &str) -> String {
    let mut out = String::new();
    for (user, files) in fixture.snapshot(change).review {
        for (file, revision) in files {
            writeln!(out, "{user} {file} {}", short(revision)).unwrap();
        }
    }
    out
}

/// What marking the files `pathspecs` match of `change` up to `head`'s tip marks, or why not.
fn mark(fixture: &Fixture, change: &str, pathspecs: &[&str], head: Option<&str>) -> String {
    let pathspecs: Vec<Pathspec> = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect();
    let head = head.map(|change| fixture.tip(change));
    match fixture.cabaret.mark(&id(change), &pathspecs, head) {
        Ok(files) => format!("{files:?}"),
        Err(error) => format!("error: {error:?}"),
    }
}

/// `child` has one commit past its parent `main`.
fn stacked() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("greeting.txt", "hi\n"), ("extra.txt", "extra\n")]);
    fixture
}

#[test]
fn mark_defaults_to_tip() {
    let fixture = stacked();
    expect![[r#"{"extra.txt", "greeting.txt"}"#]].assert_eq(&mark(
        &fixture,
        "child",
        &["greeting.txt", "extra.txt"],
        None,
    ));
    expect![[r#"
        alice@example.com extra.txt TIP
        alice@example.com greeting.txt TIP
    "#]]
    .assert_eq(&review(&fixture, "child").replace(&short(fixture.tip("child")), "TIP"));
}

#[test]
fn later_mark_replaces_earlier_one() {
    let fixture = stacked();
    fixture.branch("earlier", "child");
    fixture.commit("child", &[("greeting.txt", "hey\n")]);
    expect![[r#"{"greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["greeting.txt"], Some("earlier")));
    expect![[r#"
        alice@example.com greeting.txt EARLIER
    "#]]
    .assert_eq(&review(&fixture, "child").replace(&short(fixture.tip("earlier")), "EARLIER"));
    expect![[r#"{"greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
    expect![[r#"
        alice@example.com greeting.txt TIP
    "#]]
    .assert_eq(&review(&fixture, "child").replace(&short(fixture.tip("child")), "TIP"));
}

#[test]
fn mark_refuses_pathspec_matching_nothing_and_marks_nothing() {
    let fixture = stacked();
    expect!["error: nothing left to review or marked before in child matches 'missing.txt'"].assert_eq(&mark(
        &fixture,
        "child",
        &["greeting.txt", "missing.txt"],
        None,
    ));
    expect![""].assert_eq(&review(&fixture, "child"));
}

#[test]
fn remark_of_file_reverted_since_its_mark() {
    let fixture = stacked();
    expect![[r#"{"greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
    fixture.commit("child", &[("greeting.txt", "hello\n")]);
    expect![[r#"{"greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
    expect![[r#"{"greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
}

#[test]
fn remark_of_reviewed_file_unchanged_since_moves_it_to_tip() {
    let fixture = stacked();
    expect![[r#"{"greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
    fixture.commit("child", &[("extra.txt", "more\n")]);
    expect![[r#"{"greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
    expect![[r#"
        alice@example.com greeting.txt TIP
    "#]]
    .assert_eq(&review(&fixture, "child").replace(&short(fixture.tip("child")), "TIP"));
}

#[test]
fn mark_matches_reviewed_files_too() {
    let fixture = stacked();
    mark(&fixture, "child", &["greeting.txt"], None);
    expect![[r#"{"extra.txt", "greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["*"], None));
}

#[test]
fn mark_matches_globs_and_directories() {
    let fixture = stacked();
    fixture.commit("child", &[("dir/c.txt", "c\n"), ("dir/d.md", "d\n")]);
    expect![[r#"{"dir/c.txt", "dir/d.md"}"#]].assert_eq(&mark(&fixture, "child", &["dir"], None));
    expect![[r#"{"dir/c.txt", "extra.txt", "greeting.txt"}"#]].assert_eq(&mark(&fixture, "child", &["*.txt"], None));
}

#[test]
fn mark_matches_rename_by_its_source() {
    let fixture = stacked();
    fixture.remove("child", &["greeting.txt"]);
    fixture.commit("child", &[("renamed.txt", "hello\n")]);
    expect![[r#"{"renamed.txt"}"#]].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
}
