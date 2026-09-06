use std::{fmt::Write, fs, os::unix::fs::PermissionsExt, path::Path};

use cabaret_agents::{Acp, Session};
use expect_test::expect;

/// A fake agent that answers `initialize` and then `session/list` with canned responses. It reads
/// a line before each answer so the client never writes to a closed pipe.
fn fake_agent(dir: &Path, capabilities: &str, sessions: &str) -> std::path::PathBuf {
    let script = format!(
        "#!/bin/sh\nread line\necho '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"protocolVersion\":1,\"agentCapabilities\":{capabilities}}}}}'\n\
         read line\necho '{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{}}}}'\n\
         echo '{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"sessions\":{sessions}}}}}'\n"
    );
    let path = dir.join("agent");
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn render(sessions: &[Session]) -> String {
    let mut out = String::new();
    for Session { id, title, last_active } in sessions {
        writeln!(out, "{id} {} {title:?}", last_active.0).unwrap();
    }
    out
}

#[test]
fn sessions_launched_from_directory_ordered_by_activity() {
    let dir = tempfile::tempdir().unwrap();
    let agent = fake_agent(
        dir.path(),
        r#"{"sessionCapabilities":{"list":{}}}"#,
        r#"[{"sessionId":"older","cwd":"/repo/main","title":"Parser fix","updatedAt":"1970-01-01T00:16:40Z"},{"sessionId":"newer","cwd":"/repo/main","updatedAt":"1970-01-01T00:33:20.500Z"},{"sessionId":"sibling","cwd":"/repo/feature-x","updatedAt":"1970-01-01T00:50:00Z"}]"#,
    );
    expect![[r#"
        newer 2000500 None
        older 1000000 Some("Parser fix")
    "#]]
    .assert_eq(&render(&Acp::new(agent).sessions_in(Path::new("/repo/main")).unwrap()));
}

#[test]
fn agent_without_list_capability_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let agent = fake_agent(dir.path(), "{}", "[]");
    let error = Acp::new(agent).sessions_in(Path::new("/repo/main")).unwrap_err();
    assert!(format!("{error:?}").ends_with("agent cannot list sessions"), "{error:?}");
}
