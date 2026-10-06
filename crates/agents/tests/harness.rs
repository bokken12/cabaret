use cabaret_agents::{ClaudeCode, Codex, Harness, Harnesses, Provider, SessionId};
use std::{fs, path::Path};

#[test]
fn claude_manual_lookup_works_and_automatic_identification_is_explicitly_unimplemented() {
    let home = tempfile::tempdir().unwrap();
    let history = home.path().join("projects/-launch-parent");
    fs::create_dir_all(&history).unwrap();
    fs::write(
        history.join("claude-session.jsonl"),
        r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hello"}}"#,
    )
    .unwrap();
    let adapter = ClaudeCode::new(home.path().into());
    let id = SessionId("claude-session".into());
    assert!(adapter.current_session_id().unwrap().is_none());
    assert!(adapter.info().identification.contains("NOT IMPLEMENTED"));
    assert!(adapter.info().requires_directory);
    assert!(format!("{:?}", Harness::session(&adapter, &id, None).unwrap_err()).contains("--directory"));
    let session = Harness::session(&adapter, &id, Some(Path::new("/launch/parent")))
        .unwrap()
        .unwrap();
    assert_eq!(session.directory, Path::new("/launch/parent"));
    assert_eq!(session.provider, Provider::Claude);
    assert!(session.live.is_none());
    assert_eq!(
        adapter.sessions_without_checkout(Path::new("/launch/parent")).unwrap(),
        vec![session]
    );
}

#[test]
fn registry_routes_resume_by_provider_without_interpolating_shell_text() {
    let home = tempfile::tempdir().unwrap();
    let adapters = Harnesses::new(vec![
        Box::new(ClaudeCode::new(home.path().join("claude"))),
        Box::new(Codex::new(home.path().join("codex"))),
    ])
    .unwrap();
    let directory = Path::new("/launch/with spaces and 'quotes'");
    let id = SessionId("same-id".into());
    let claude = adapters.resume(Provider::Claude, &id, directory).unwrap();
    let codex = adapters.resume(Provider::Codex, &id, directory).unwrap();
    assert_eq!(claude.program, "claude");
    assert_eq!(claude.args, ["--resume", "same-id"]);
    assert_eq!(codex.program, "codex");
    assert_eq!(codex.args, ["resume", "same-id"]);
    assert_eq!(claude.directory, directory.to_str().unwrap());
    assert_eq!(codex.directory, claude.directory);
    assert!(
        adapters
            .resume(Provider::Codex, &SessionId("../bad".into()), directory)
            .is_err()
    );
    assert!(adapters.resume(Provider::Claude, &id, Path::new("relative")).is_err());
    assert!(adapters.named("pi").is_err());
    assert_eq!(adapters.named("claude").unwrap().info().provider, Provider::Claude);
    assert!(
        adapters
            .iter()
            .all(|adapter| adapter.sessions_in(directory).unwrap().is_empty())
    );
}

#[test]
fn duplicate_registration_is_rejected() {
    let home = tempfile::tempdir().unwrap();
    assert!(
        Harnesses::new(vec![
            Box::new(Codex::new(home.path().into())),
            Box::new(Codex::new(home.path().into())),
        ])
        .is_err()
    );
}
