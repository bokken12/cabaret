//! Next steps: the first thing standing between a change and landing, as its show page names it.

use std::fmt::Write as _;

use cabaret_lib::{
    Hints, Scope,
    safeguard::{Allow, SafeguardKind},
};
use expect_test::expect;
use nonempty_collections::nebts;

use super::fixture::{Fixture, alice, carol, id, scene};

fn next_step(fixture: &Fixture, change: &str) -> String {
    let page = fixture.cabaret.show_page(&id(change)).unwrap().to_string();
    page.lines().find_map(|line| line.strip_prefix("Next step: ")).unwrap().to_owned()
}

#[test]
fn scene_next_steps() {
    let fixture = scene();
    let mut out = String::new();
    for change in fixture.cabaret.changes().unwrap() {
        writeln!(out, "{change}: {}", next_step(&fixture, &change.to_string())).unwrap();
    }
    expect![[r#"
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
        unlogged: (none)
    "#]]
    .assert_eq(&out);
}

#[test]
fn reviewed_change_lands_into_its_parent() {
    let fixture = scene();
    fixture.mark_all("single");
    expect!["[!l] land into main"].assert_eq(&next_step(&fixture, "single"));
}

#[test]
fn reviewed_change_with_several_parents_waits_for_them_to_land() {
    let fixture = scene();
    fixture.cabaret.add_owner(&id("fork-join"), &alice()).unwrap();
    let allow = Allow::from_iter([SafeguardKind::RemovesOthers]);
    fixture.cabaret.remove_owner(&id("fork-join"), &carol(), &allow).unwrap();
    fixture.mark_all("fork-join");
    expect!["[^] land parents fork-left, fork-right"].assert_eq(&next_step(&fixture, "fork-join"));
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
    fixture.cabaret.rebase(&id("child"), None, &Allow::default()).unwrap();
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
    expect!["[^] resolve conflicts in child"].assert_eq(&next_step(&fixture, "grandchild"));
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    expect!["[!r] rebase onto child"].assert_eq(&next_step(&fixture, "grandchild"));
}

#[test]
fn conflict_between_parents_is_resolved_in_their_join() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.txt", "original\n")]);
    fixture.create("left", "main", &alice());
    fixture.commit("left", &[("file.txt", "left\n")]);
    fixture.create("right", "main", &alice());
    fixture.commit("right", &[("file.txt", "right\n")]);
    fixture.cabaret.create("join", &nebts![id("left"), id("right")], &alice()).unwrap();
    expect!["resolve conflicts in file.txt"].assert_eq(&next_step(&fixture, "join"));
}

#[test]
fn trunk_is_never_conflicted() {
    let fixture = Fixture::new();
    fixture.root("main", &[("markers.txt", "<<<<<<< not a conflict\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("child.txt", "child\n")]);
    fixture.commit("main", &[("main.txt", "main\n")]);
    expect!["[!r] rebase onto main"].assert_eq(&next_step(&fixture, "child"));
}

#[test]
fn hidden_hints_leave_keys_out() {
    let fixture = scene();
    fixture.cabaret.set_config(Scope::Local, &Hints::Hidden).unwrap();
    expect!["rebase onto advanced-parent"].assert_eq(&next_step(&fixture, "behind-child"));
}
