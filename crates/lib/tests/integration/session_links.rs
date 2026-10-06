use super::fixture::{Fixture, alice, id, open_cabaret};
use cabaret_lib::{ClaudeCode, Codex, Harnesses, Provider, Session, SessionId};
use serde_json::json;
use std::fs;

#[test]
fn parent_session_must_release_its_link_before_switching_worktrees() {
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
    let registry = cab.common_dir().join("cabaret/session-links.json");
    let before = fs::read(&registry).unwrap();
    let error = cab.link_session(&id("two"), &session).unwrap_err();
    assert!(format!("{error:?}").contains("unlink it first"));
    assert_eq!(fs::read(&registry).unwrap(), before);
    let other = open_cabaret(workspace.workdir().unwrap());
    assert_eq!(other.session_links(&id("one")).unwrap().len(), 1);
    assert_eq!(
        other.agent_sessions(&id("one"), &harnesses).unwrap(),
        vec![session.clone()]
    );
    assert!(cab.agent_sessions(&id("two"), &harnesses).unwrap().is_empty());
    // Unlinking from any checkout releases the shared association.
    other.unlink_session(&id("one"), session.provider, &session.id).unwrap();
    cab.link_session(&id("two"), &session).unwrap();
    assert!(other.session_links(&id("one")).unwrap().is_empty());
    fs::remove_file(path).unwrap();
    let missing = cab.agent_sessions(&id("two"), &harnesses).unwrap();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].directory, fixture.path(""));
    assert!(missing[0].last_active.is_none());
    assert!(missing[0].live.is_none());
    cab.unlink_session(&id("two"), Provider::Codex, &SessionId("parent-session".into())).unwrap();
    assert!(cab.session_links(&id("two")).unwrap().is_empty());
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
    fixture.cabaret.unlink_session(&id("main"), session.provider, &session.id).unwrap();
    assert_eq!(fixture.cabaret.agent_sessions(&id("main"), &harnesses).unwrap().len(), 1);
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
    let error = cab.unlink_session(&id("main"), Provider::Codex, &session.id).unwrap_err();
    assert!(format!("{error:?}").contains("Retry the command"));
    assert!(format!("{error:?}").contains("was not saved"));
    assert_eq!(fs::read(&path).unwrap(), before);
    drop(lock);
    cab.unlink_session(&id("main"), Provider::Codex, &session.id).unwrap();
    assert!(cab.session_links(&id("main")).unwrap().is_empty());
}


#[test]
fn legacy_duplicate_links_require_explicit_cleanup_without_choosing_a_winner() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    fixture.create("one", "main", &alice());
    fixture.create("two", "main", &alice());
    let cab = &fixture.cabaret;
    let session = Session {
        id: SessionId("legacy".into()), provider: Provider::Codex,
        directory: fixture.path(""), title: None, last_active: None, live: None,
    };
    cab.link_session(&id("one"), &session).unwrap();
    let path = cab.common_dir().join("cabaret/session-links.json");
    let mut links = cab.session_links(&id("one")).unwrap();
    let mut duplicate = links[0].clone();
    duplicate.change = id("two");
    links.push(duplicate);
    fs::write(&path, serde_json::to_vec(&links).unwrap()).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(cab.link_session(&id("one"), &session).is_err());
    assert!(cab.link_session(&id("main"), &session).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    cab.unlink_session(&id("two"), session.provider, &session.id).unwrap();
    cab.link_session(&id("one"), &session).unwrap();
    assert_eq!(cab.session_links(&id("one")).unwrap().len(), 1);
}

#[test]
fn unlink_can_release_a_deleted_change_without_deleting_other_sessions() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    let cab = &fixture.cabaret;
    let session = Session {
        id: SessionId("orphan".into()), provider: Provider::Codex,
        directory: fixture.path(""), title: None, last_active: None, live: None,
    };
    cab.link_session(&id("main"), &session).unwrap();
    let path = cab.common_dir().join("cabaret/session-links.json");
    let mut links = cab.session_links(&id("main")).unwrap();
    let mut orphan = links[0].clone();
    orphan.change = id("deleted");
    orphan.id = SessionId("different-session".into());
    links.push(orphan);
    fs::write(&path, serde_json::to_vec(&links).unwrap()).unwrap();
    cab.unlink_session(&id("deleted"), Provider::Codex, &SessionId("different-session".into())).unwrap();
    assert_eq!(cab.session_links(&id("main")).unwrap().len(), 1);
    assert_eq!(serde_json::from_slice::<Vec<serde_json::Value>>(&fs::read(&path).unwrap()).unwrap().len(), 1);
}


#[test]
fn simultaneous_links_for_the_same_session_fail_with_an_ownership_conflict() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    fixture.create("one", "main", &alice());
    fixture.create("two", "main", &alice());
    let one = fixture.add_workspace("one").workdir().unwrap().to_path_buf();
    let two = fixture.add_workspace("two").workdir().unwrap().to_path_buf();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let directory = fixture.path("");
    let handles: Vec<_> = [(one, "one"), (two, "two")].into_iter().map(|(path, change)| {
        let barrier = barrier.clone();
        let directory = directory.clone();
        std::thread::spawn(move || {
            let cab = open_cabaret(path);
            let session = Session {
                id: SessionId("competing".into()), provider: Provider::Codex,
                directory, title: None, last_active: None, live: None,
            };
            barrier.wait();
            cab.link_session(&id(change), &session).map_err(|error| format!("{error:?}"))
        })
    }).collect();
    let results: Vec<_> = handles.into_iter().map(|handle| handle.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let error = results.iter().find_map(|result| result.as_ref().err()).unwrap();
    assert!(error.contains("already has an explicit link"), "{error}");
    let links = fixture.cabaret.session_links(&id("one")).unwrap().len()
        + fixture.cabaret.session_links(&id("two")).unwrap().len();
    assert_eq!(links, 1);
}


#[test]
fn simultaneous_links_for_distinct_sessions_both_succeed() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    fixture.create("one", "main", &alice());
    fixture.create("two", "main", &alice());
    let one = fixture.add_workspace("one").workdir().unwrap().to_path_buf();
    let two = fixture.add_workspace("two").workdir().unwrap().to_path_buf();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let directory = fixture.path("");
    let handles: Vec<_> = [(one, "one"), (two, "two")].into_iter().map(|(path, change)| {
        let barrier = barrier.clone();
        let directory = directory.clone();
        std::thread::spawn(move || {
            let cab = open_cabaret(path);
            let session = Session {
                id: SessionId(format!("session-{change}")), provider: Provider::Codex,
                directory, title: None, last_active: None, live: None,
            };
            barrier.wait();
            cab.link_session(&id(change), &session)
        })
    }).collect();
    for handle in handles { handle.join().unwrap().unwrap(); }
    assert_eq!(fixture.cabaret.session_links(&id("one")).unwrap().len(), 1);
    assert_eq!(fixture.cabaret.session_links(&id("two")).unwrap().len(), 1);
}

#[test]
fn a_link_waits_for_a_brief_lock_then_reads_the_latest_registry() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "a")]);
    let path = fixture.cabaret.common_dir().join("cabaret/session-links.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut lock = gix::lock::File::acquire_to_update_resource(&path, gix::lock::acquire::Fail::Immediately, None).unwrap();
    let directory = fixture.path("");
    let checkout = fixture.path("main");
    let session = Session {
        id: SessionId("after-lock".into()), provider: Provider::Codex,
        directory: directory.clone(), title: None, last_active: None, live: None,
    };
    let (started, waiting) = std::sync::mpsc::channel();
    let (done, result) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let cab = open_cabaret(checkout);
        started.send(()).unwrap();
        done.send(cab.link_session(&id("main"), &session)).unwrap();
    });
    waiting.recv().unwrap();
    assert!(matches!(result.recv_timeout(std::time::Duration::from_millis(100)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
    let existing = cabaret_lib::SessionLink {
        change: id("main"), provider: Provider::Codex,
        id: SessionId("before-lock".into()), directory,
    };
    serde_json::to_writer(&mut lock, &[existing]).unwrap();
    lock.commit().unwrap();
    result.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
    worker.join().unwrap();
    assert_eq!(fixture.cabaret.session_links(&id("main")).unwrap().len(), 2);
}
