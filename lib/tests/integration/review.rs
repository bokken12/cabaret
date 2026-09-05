//! Review marks: which range of a change each user has read, per file.

use std::{collections::BTreeSet, fmt::Write as _};

use cabaret_lib::RepoPath;
use expect_test::expect;

use super::fixture::{Fixture, alice, id, short};

fn path(file: &str) -> RepoPath { file.parse().unwrap() }

/// Every mark as `user file bases..head`, with short hashes.
fn review(fixture: &Fixture, change: &str) -> String {
    let mut out = String::new();
    for (user, files) in fixture.snapshot(change).review {
        for (file, range) in files {
            let bases: Vec<String> = range.bases.into_iter().map(short).collect();
            writeln!(out, "{user} {file} {}..{}", bases.join(","), short(range.head)).unwrap();
        }
    }
    out
}

fn mark(fixture: &Fixture, change: &str, files: &[&str], head: Option<&str>, bases: Option<&[&str]>) -> String {
    let files: Vec<RepoPath> = files.iter().map(|file| path(file)).collect();
    let head = head.map(|change| fixture.tip(change));
    let bases: Option<BTreeSet<_>> = bases.map(|bases| bases.iter().map(|change| fixture.tip(change)).collect());
    match fixture.cabaret.mark(&id(change), &files, head, bases) {
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
fn mark_defaults_to_bases_and_tip() {
    let fixture = stacked();
    expect!["ok"].assert_eq(&mark(&fixture, "child", &["greeting.txt", "extra.txt"], None, None));
    let (base, tip) = (short(fixture.tip("main")), short(fixture.tip("child")));
    expect![[r#"
        alice@example.com extra.txt BASE..TIP
        alice@example.com greeting.txt BASE..TIP
    "#]]
    .assert_eq(&review(&fixture, "child").replace(&base, "BASE").replace(&tip, "TIP"));
}

#[test]
fn later_mark_replaces_earlier_one() {
    let fixture = stacked();
    fixture.branch("earlier", "child");
    fixture.commit("child", &[("greeting.txt", "hey\n")]);
    expect!["ok"].assert_eq(&mark(&fixture, "child", &["greeting.txt"], Some("earlier"), Some(&["main"])));
    let earlier = short(fixture.tip("earlier"));
    expect![[r#"
        alice@example.com greeting.txt BASE..EARLIER
    "#]]
    .assert_eq(&review(&fixture, "child").replace(&short(fixture.tip("main")), "BASE").replace(&earlier, "EARLIER"));
    expect!["ok"].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None, None));
    expect![[r#"
        alice@example.com greeting.txt BASE..TIP
    "#]]
    .assert_eq(
        &review(&fixture, "child")
            .replace(&short(fixture.tip("main")), "BASE")
            .replace(&short(fixture.tip("child")), "TIP"),
    );
}

#[test]
fn marking_same_range_again_refuses() {
    let fixture = stacked();
    expect!["ok"].assert_eq(&mark(&fixture, "child", &["greeting.txt"], None, None));
    expect!["error: child already had these files marked reviewed there"].assert_eq(&mark(
        &fixture,
        "child",
        &["greeting.txt"],
        None,
        None,
    ));
}
