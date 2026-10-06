use super::fixture::{Fixture, alice, id, open_cabaret};
use cabaret_lib::{ClaudeCode, Codex, Harnesses, Provider, Session, SessionId};
use serde_json::json;
use std::fs;

#[test]
fn parent_session_is_explicit_many_to_many_and_shared_between_worktrees() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    fixture.create("one", "main", &alice());
    fixture.create("two", "main", &alice());
    let workspace = fixture.add_workspace("one");
    fixture.add_workspace("two");
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("sessions/2026/10/05/session.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, format!("{}\n", json!({"type":"session_meta","timestamp":"2026-10-05T10:00:00Z","payload":{"id":"parent-session","cwd":fixture.path("")}}))).unwrap();
    let codex = Codex::new(home.path().to_owned());
    let claude = ClaudeCode::new(home.path().join("claude"));
    let harnesses = Harnesses::new(vec![Box::new(claude), Box::new(codex)]).unwrap();
    let cab = &fixture.cabaret;
    assert!(cab.agent_sessions(&id("one"), &harnesses).unwrap().is_empty());
    let session = harnesses.get(Provider::Codex).unwrap().session(&SessionId("parent-session".into()), None).unwrap().unwrap();
    cab.link_session(&id("one"), &session).unwrap();
    cab.link_session(&id("one"), &session).unwrap();
    cab.link_session(&id("two"), &session).unwrap();
    let other = open_cabaret(workspace.workdir().unwrap());
    assert_eq!(other.session_links(&id("one")).unwrap().len(), 1);
    assert_eq!(
        other.agent_sessions(&id("one"), &harnesses).unwrap(),
        vec![session.clone()]
    );
    assert_eq!(cab.agent_sessions(&id("two"), &harnesses).unwrap(), vec![session]);
    fs::remove_file(path).unwrap();
    let missing = cab.agent_sessions(&id("one"), &harnesses).unwrap();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].directory, fixture.path(""));
    assert!(missing[0].last_active.is_none());
    assert!(missing[0].live.is_none());
    cab.unlink_session(&id("one"), Provider::Codex, &SessionId("parent-session".into()))
        .unwrap();
    assert!(cab.session_links(&id("one")).unwrap().is_empty());
    assert_eq!(cab.session_links(&id("two")).unwrap().len(), 1);
}

#[test]
fn providers_are_distinct_and_corrupt_registry_is_not_overwritten() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    let cab = &fixture.cabaret;
    let mut session = Session {
        id: SessionId("same-id".into()),
        provider: Provider::Codex,
        directory: fixture.path(""),
        title: None,
        last_active: None,
        live: None,
    };
    cab.link_session(&id("main"), &session).unwrap();
    session.provider = Provider::Claude;
    cab.link_session(&id("main"), &session).unwrap();
    assert_eq!(cab.session_links(&id("main")).unwrap().len(), 2);
    let path = cab.common_dir().join("cabaret/session-links.json");
    fs::write(&path, "invalid").unwrap();
    assert!(cab.link_session(&id("main"), &session).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "invalid");
}

#[test]
fn inferred_sessions_are_not_duplicated_by_links() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("sessions/2026/10/05/session.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":"local","cwd":fixture.path("main")}})
        ),
    )
    .unwrap();
    let codex = Codex::new(home.path().to_owned());
    let claude = ClaudeCode::new(home.path().join("claude"));
    let session = codex.session(&SessionId("local".into())).unwrap().unwrap();
    let harnesses = Harnesses::new(vec![Box::new(claude), Box::new(codex)]).unwrap();
    fixture.cabaret.link_session(&id("main"), &session).unwrap();
    assert_eq!(
        fixture
            .cabaret
            .agent_sessions(&id("main"), &harnesses)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn concurrent_writer_lock_leaves_existing_links_untouched() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    let cab = &fixture.cabaret;
    let session = Session {
        id: SessionId("one".into()),
        provider: Provider::Codex,
        directory: fixture.path(""),
        title: None,
        last_active: None,
        live: None,
    };
    cab.link_session(&id("main"), &session).unwrap();
    let path = cab.common_dir().join("cabaret/session-links.json");
    let before = fs::read(&path).unwrap();
    let lock = gix::lock::File::acquire_to_update_resource(&path, gix::lock::acquire::Fail::Immediately, None).unwrap();
    assert!(cab.unlink_session(&id("main"), Provider::Codex, &session.id).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    drop(lock);
    cab.unlink_session(&id("main"), Provider::Codex, &session.id).unwrap();
    assert!(cab.session_links(&id("main")).unwrap().is_empty());
}
