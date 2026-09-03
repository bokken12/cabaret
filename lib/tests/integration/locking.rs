//! Transactions lock each metadata and branch they write, so two writing the same one run one
//! after the other while the metadata and branch of one change stay independent.

use std::{thread, time::Duration};

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
        assert_eq!(fixture.snapshot("child").title, None);
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
    assert_eq!(fixture.snapshot("child").title, None);
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
    fixture.cabaret.rebase(&id("child"), None).unwrap();
    assert_eq!(fixture.tip("child"), fixture.tip("main"));
}
