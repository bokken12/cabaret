//! Review marks: which range of a change each user has read, per file.

use std::fmt::Write as _;

use cabaret_lib::RepoPath;
use expect_test::expect;

use super::fixture::{Fixture, alice, id, short};

fn path(file: &str) -> RepoPath { file.parse().unwrap() }

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

fn mark(fixture: &Fixture, change: &str, files: &[&str], head: Option<&str>) -> String {
    let files: Vec<RepoPath> = files.iter().map(|file| path(file)).collect();
    let head = head.map(|change| fixture.tip(change));
    match fixture.cabaret.mark(&id(change), &files, head) {
        Ok(()) => "ok".into(),
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
    expect!["ok"].assert_eq(&mark(&fixture, "child", &["greeting.txt", "extra.txt"], None));
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
    expect!["ok"].assert_eq(&mark(&fixture, "child", &["greeting.txt"], Some("earlier")));
    expect![[r#"
        alice@example.com greeting.txt EARLIER
    "#]]
    .assert_eq(&review(&fixture, "child").replace(&short(fixture.tip("earlier")), "EARLIER"));
    expect!["ok"].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
    expect![[r#"
        alice@example.com greeting.txt TIP
    "#]]
    .assert_eq(&review(&fixture, "child").replace(&short(fixture.tip("child")), "TIP"));
}

#[test]
fn marking_same_revision_again_refuses() {
    let fixture = stacked();
    expect!["ok"].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None));
    expect!["error: child already had these files marked reviewed there"].assert_eq(&mark(
        &fixture,
        "child",
        &["greeting.txt"],
        None,
    ));
}
