//! Transactions lock each metadata and branch they write, so two writing the same one run one
//! after the other while the metadata and branch of one change stay independent. A workspace's
//! files are guarded by the lock of the branch it holds, which fast-forwards write under.

use std::{thread, time::Duration};

use cabaret_lib::{
    WorkspaceId,
    safeguard::{RebaseAllow, SwitchWorkspaceAllow},
};

use super::fixture::{Fixture, alice, id};

fn parent_and_child() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture
}

#[test]
fn second_transaction_waits_for_first() {
    let fixture = parent_and_child();
    let lock = fixture.hold_lock("metadata", "child");
    thread::scope(|scope| {
        let second = scope.spawn(|| fixture.cabaret.set_title(&id("child"), Some("titled".into())));
        thread::sleep(Duration::from_millis(500));
        assert!(!second.is_finished(), "the second transaction ran despite the held lock");
        assert_eq!(fixture.snapshot("child").title.as_deref(), Some("child"));
        drop(lock);
        second.join().unwrap().unwrap();
    });
    assert_eq!(fixture.snapshot("child").title, Some("titled".into()));
}

#[test]
fn other_changes_are_not_held_up() {
    let fixture = parent_and_child();
    let _lock = fixture.hold_lock("metadata", "main");
    fixture.cabaret.set_title(&id("child"), Some("titled".into())).unwrap();
    assert_eq!(fixture.snapshot("child").title, Some("titled".into()));
}

#[test]
fn queries_take_no_locks() {
    let fixture = parent_and_child();
    let _lock = fixture.hold_lock("metadata", "child");
    assert_eq!(fixture.snapshot("child").title.as_deref(), Some("child"));
}

#[test]
fn a_held_branch_does_not_hold_up_the_metadata() {
    let fixture = parent_and_child();
    let _lock = fixture.hold_lock("branch", "child");
    fixture.cabaret.set_title(&id("child"), Some("titled".into())).unwrap();
    assert_eq!(fixture.snapshot("child").title, Some("titled".into()));
}

#[test]
fn held_metadata_does_not_hold_up_the_branch() {
    let fixture = parent_and_child();
    fixture.commit("main", &[("main.txt", "main\n")]);
    let _lock = fixture.hold_lock("metadata", "child");
    fixture.cabaret.rebase(&id("child"), None, RebaseAllow::default()).unwrap();
    assert_eq!(fixture.tip("child"), fixture.tip("main"));
}

#[test]
fn switch_waits_for_branch_it_leaves() {
    let fixture = parent_and_child();
    fixture.checkout("main");
    let lock = fixture.hold_lock("branch", "main");
    thread::scope(|scope| {
        let switch = scope.spawn(|| {
            let allow = SwitchWorkspaceAllow::default();
            fixture.cabaret.workspace_switch(WorkspaceId::Main.to_ref(), id("child"), allow)
        });
        thread::sleep(Duration::from_millis(500));
        assert!(!switch.is_finished(), "the switch ran despite the held lock");
        drop(lock);
        switch.join().unwrap().unwrap();
    });
    assert_eq!(fixture.snapshot("child").workspace, Some(WorkspaceId::Main));
}

#[test]
fn discard_waits_for_branch_of_workspace() {
    let fixture = parent_and_child();
    fixture.checkout("child");
    fixture.write("scratch.txt", "scratch\n");
    let lock = fixture.hold_lock("branch", "child");
    thread::scope(|scope| {
        let discard = scope.spawn(|| fixture.cabaret.discard(&id("child"), &[]));
        thread::sleep(Duration::from_millis(500));
        assert!(!discard.is_finished(), "the discard ran despite the held lock");
        drop(lock);
        discard.join().unwrap().unwrap();
    });
    assert!(!fixture.exists("scratch.txt"));
}
