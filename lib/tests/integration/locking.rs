//! Transactions hold a lock per change, so two on the same change run one after the other.

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
    let lock = fixture.hold_lock("child");
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
    let _lock = fixture.hold_lock("main");
    fixture.cabaret.set_title(&id("child"), Some("titled".into())).unwrap();
    assert_eq!(fixture.snapshot("child").title, Some("titled".into()));
}

#[test]
fn queries_take_no_locks() {
    let fixture = parent_and_child();
    let _lock = fixture.hold_lock("child");
    assert_eq!(fixture.snapshot("child").title, None);
}
