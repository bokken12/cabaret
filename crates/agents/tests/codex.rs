use cabaret_agents::{Codex, Provider, SessionId, validate_session_id};
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn rollout(home: &Path, id: &str, cwd: &Path) -> PathBuf {
    let path = home.join(format!("sessions/2026/10/05/rollout-{id}.jsonl"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, format!("{}\n{}\n", json!({"type":"session_meta","timestamp":"2026-10-05T10:00:00Z","payload":{"id":id,"cwd":cwd}}), json!({"type":"event_msg","timestamp":"2026-10-05T10:01:00Z","payload":{"type":"user_message","message":"fix the parser\nplease"}}))).unwrap();
    path
}

#[test]
fn matches_descendants_but_never_attributes_parent_or_sibling_sessions() {
    let home = tempfile::tempdir().unwrap();
    rollout(home.path(), "parent", Path::new("/repos"));
    rollout(home.path(), "child", Path::new("/repos/feature/src"));
    rollout(home.path(), "sibling", Path::new("/repos/feature-other"));
    let codex = Codex::new(home.path().to_owned());
    let sessions = codex.sessions_in(Path::new("/repos/feature")).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id.0, "child");
    assert_eq!(sessions[0].provider, Provider::Codex);
    assert_eq!(sessions[0].title.as_deref(), Some("fix the parser"));
    assert!(sessions[0].live.is_none());
    assert_eq!(
        codex.session(&SessionId("parent".into())).unwrap().unwrap().directory,
        Path::new("/repos")
    );
}

#[test]
fn cached_sessions_pick_up_append_and_ignore_partial_tail() {
    let home = tempfile::tempdir().unwrap();
    let path = rollout(home.path(), "one", Path::new("/repos/feature"));
    let codex = Codex::new(home.path().to_owned());
    let id = SessionId("one".into());
    let first = codex.session(&id).unwrap().unwrap();
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        file,
        "{}",
        json!({"timestamp":"2026-10-05T10:02:00Z","type":"event_msg"})
    )
    .unwrap();
    write!(file, "{{\"timestamp\":").unwrap();
    let second = codex.session(&id).unwrap().unwrap();
    assert!(second.last_active > first.last_active);
    assert!(second.live.is_none());
    fs::remove_file(path).unwrap();
    assert!(codex.session(&id).unwrap().is_none());
}

#[test]
fn incomplete_metadata_archives_and_unsafe_ids_are_not_discovered() {
    let home = tempfile::tempdir().unwrap();
    let path = rollout(home.path(), "one", Path::new("/repos/feature"));
    fs::write(&path, "{\"type\":\"session_meta\"").unwrap();
    let archive = home.path().join("archived_sessions");
    fs::create_dir(&archive).unwrap();
    let archived = rollout(home.path(), "archived", Path::new("/repos/feature"));
    fs::rename(archived, archive.join("archived.jsonl")).unwrap();
    let relative = rollout(home.path(), "relative", Path::new("relative/path"));
    assert!(relative.exists());
    assert!(
        Codex::new(home.path().to_owned())
            .sessions_in(Path::new("/repos/feature"))
            .unwrap()
            .is_empty()
    );
    for id in ["", "../escape", "$(whoami)", "a;b", "--resume x"] {
        assert!(validate_session_id(&SessionId(id.into())).is_err());
    }
}

#[test]
fn very_large_transcript_records_do_not_hide_metadata_or_last_complete_activity() {
    let home = tempfile::tempdir().unwrap();
    let path = rollout(home.path(), "one", Path::new("/repos/feature"));
    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(
        file,
        "{}",
        json!({"type":"response_item","payload":"x".repeat(200_000)})
    )
    .unwrap();
    writeln!(
        file,
        "{}",
        json!({"timestamp":"2026-10-05T10:03:00Z","type":"event_msg"})
    )
    .unwrap();
    let session = Codex::new(home.path().to_owned())
        .session(&SessionId("one".into()))
        .unwrap()
        .unwrap();
    assert_eq!(session.last_active.unwrap().0, 1791194580000);
}
