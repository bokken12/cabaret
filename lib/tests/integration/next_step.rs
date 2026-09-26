//! Next steps: the first thing standing between a change and landing, as its show page names it.

use std::fmt::Write as _;

use cabaret_lib::{Hints, RepoPath, Scope};
use expect_test::expect;

use super::fixture::{Fixture, alice, carol, id, scene};

fn next_step(fixture: &Fixture, change: &str) -> String {
    let page = fixture.cabaret.show_page(&id(change)).unwrap().to_string();
    page.lines().find_map(|line| line.strip_prefix("Next step: ")).unwrap().to_owned()
}

/// Mark every file of `change` reviewed as the fixture's identity.
fn review(fixture: &Fixture, change: &str) {
    let files = fixture.cabaret.review_files(&id(change), &[]).unwrap();
    let files: Vec<RepoPath> = files.iter().map(|file| file.path().clone()).collect();
    fixture.cabaret.mark(&id(change), &files, None).unwrap();
}

#[test]
fn scene_next_steps() {
    let fixture = scene();
    let mut out = String::new();
    for change in fixture.cabaret.changes().unwrap() {
        writeln!(out, "{change}: {}", next_step(&fixture, &change.to_string())).unwrap();
    }
    expect![[r"
        advanced-parent: [r] review by alice@example.com
        archived: (none)
        behind-child: [!r] rebase onto advanced-parent
        child-of-archived: [r] review by alice@example.com
        co-owned: [r] review by alice@example.com, bob@example.com
        described: [r] review by alice@example.com
        empty: add code
        fork-base: [r] review by alice@example.com
        fork-join: review by carol@example.com
        fork-left: [r] review by alice@example.com
        fork-right: review by bob@example.com
        main: (none)
        single: [r] review by alice@example.com
        stack-bottom: [r] review by alice@example.com
        stack-middle: [r] review by alice@example.com
        stack-top: [r] review by alice@example.com
        unlogged: [!l] land into main
    "]]
    .assert_eq(&out);
}

#[test]
fn reviewed_change_lands_into_its_parent() {
    let fixture = scene();
    review(&fixture, "single");
    expect!["[!l] land into main"].assert_eq(&next_step(&fixture, "single"));
}

#[test]
fn reviewed_change_with_several_parents_waits_for_them_to_land() {
    let fixture = scene();
    fixture.cabaret.add_owner(&id("fork-join"), &alice()).unwrap();
    fixture.cabaret.remove_owner(&id("fork-join"), &carol()).unwrap();
    review(&fixture, "fork-join");
    expect!["land parents fork-left, fork-right"].assert_eq(&next_step(&fixture, "fork-join"));
}

/// `child` rebased onto a conflicting `main`, and `grandchild` forked from `child` before that.
fn conflicted() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    fixture.create("grandchild", "child", &alice());
    fixture.commit("grandchild", &[("grandchild.txt", "grandchild\n")]);
    fixture.commit("main", &[("greeting.txt", "hey\n")]);
    fixture.cabaret.rebase(&id("child"), None).unwrap();
    fixture
}

#[test]
fn conflict_markers_are_resolved_first() {
    let fixture = conflicted();
    expect!["resolve conflicts in greeting.txt"].assert_eq(&next_step(&fixture, "child"));
}

#[test]
fn rebase_waits_for_parent_conflicts() {
    let fixture = conflicted();
    expect!["resolve conflicts in child"].assert_eq(&next_step(&fixture, "grandchild"));
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    expect!["[!r] rebase onto child"].assert_eq(&next_step(&fixture, "grandchild"));
}

#[test]
fn hidden_hints_leave_keys_out() {
    let mut fixture = scene();
    fixture.cabaret.set_config(Scope::Local, &Hints::Hidden).unwrap();
    expect!["rebase onto advanced-parent"].assert_eq(&next_step(&fixture, "behind-child"));
}
