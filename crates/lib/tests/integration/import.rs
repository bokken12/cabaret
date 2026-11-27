//! Importing a forge change's events into a change's log.

use cabaret_lib::{
    Identity,
    log::{ForgeEvent, LogAction},
};
use expect_test::expect;

use super::fixture::{Fixture, alice, id};

fn renamed(event: &str, time: i64, title: &str) -> ForgeEvent {
    ForgeEvent {
        id: event.parse().unwrap(),
        author: Identity("github:carol".into()),
        time,
        actions: vec![LogAction::SetTitle { title: Some(title.into()) }],
    }
}

/// `child` on `main`, described, its log otherwise holding just its creation.
fn child() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("child", "main", &alice());
    fixture.cabaret.set_description(&id("child"), Some("Described.".into())).unwrap();
    fixture
}

#[test]
fn joins_events_to_log_keeping_description() {
    let fixture = child();
    fixture.cabaret.import_forge_events(&id("child"), &[renamed("renamed-1", 20, "Renamed on forge")]).unwrap();
    expect![[r#"
        message "import\n"
        actions.jsonl ""
        description.md "Described."
    "#]]
    .assert_eq(&fixture.metadata("child"));
    let [_, event] = fixture.parents(fixture.log_head("child"))[..] else { panic!("one event was joined") };
    expect![[r#"
        message "{\"action\":\"set-title\",\"title\":\"Renamed on forge\"}\n"
        actions.jsonl "{\"action\":\"set-title\",\"title\":\"Renamed on forge\"}\n"
        description.md ""
        forge-event "renamed-1"
    "#]]
    .assert_eq(&fixture.metadata_at(event));
    expect![[r#"Some("Renamed on forge")"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").title));
}

#[test]
fn event_is_same_commit_whatever_log_imports_it() {
    let event = renamed("renamed-2", 30, "Renamed");
    let fresh = child();
    let written = child();
    written.cabaret.set_title(&id("child"), Some("Titled here".into())).unwrap();
    written.cabaret.import_forge_events(&id("child"), &[renamed("renamed-1", 20, "Renamed before")]).unwrap();
    let plain = Fixture::new();
    plain.root("main", &[]);
    plain.branch("child", "main");

    let imported: Vec<_> = [&fresh, &written, &plain]
        .into_iter()
        .map(|fixture| {
            fixture.cabaret.import_forge_events(&id("child"), std::slice::from_ref(&event)).unwrap();
            let head = fixture.log_head("child");
            (*fixture.parents(head).last().unwrap(), head)
        })
        .collect();
    let [(fresh_event, fresh_join), (written_event, written_join), (plain_event, plain_join)] = imported[..] else {
        panic!("three logs imported")
    };
    assert_eq!((fresh_event, fresh_event), (written_event, plain_event));
    assert!(fresh_join != written_join && written_join != plain_join && fresh_join != plain_join);
}

#[test]
fn events_already_held_write_nothing() {
    let fixture = child();
    let events = [renamed("renamed-1", 20, "Renamed"), renamed("renamed-2", 30, "Renamed again")];
    fixture.cabaret.import_forge_events(&id("child"), &events[..1]).unwrap();
    let one = fixture.log_head("child");
    fixture.cabaret.import_forge_events(&id("child"), &events[..1]).unwrap();
    assert_eq!(fixture.log_head("child"), one);
    fixture.cabaret.import_forge_events(&id("child"), &events).unwrap();
    assert_eq!(fixture.parents(fixture.log_head("child")).len(), 2);
    fixture.cabaret.import_forge_events(&id("child"), &[]).unwrap();
    expect![[r#"Some("Renamed again")"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").title));
}

#[test]
fn starts_log_of_change_without_one() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.branch("plain", "main");
    fixture.cabaret.import_forge_events(&id("plain"), &[renamed("renamed-1", 20, "Renamed")]).unwrap();
    assert_eq!(fixture.parents(fixture.log_head("plain")).len(), 1);
    expect![[r#"Some("Renamed")"#]].assert_eq(&format!("{:?}", fixture.snapshot("plain").title));
}
