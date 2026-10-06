use std::process::Command;

#[test]
fn caller_can_release_a_link_before_claiming_another_change_even_without_history() {
    let root = tempfile::tempdir().unwrap();
    let checkout = root.path().join("main");
    std::fs::create_dir(&checkout).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .current_dir(&checkout)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "--initial-branch=main"]);
    git(&["config", "user.name", "Test"]);
    git(&["config", "user.email", "test@example.com"]);
    git(&["config", "cabaret.prefix", ""]);
    git(&["commit", "--allow-empty", "-m", "initial"]);
    let home = root.path().join("codex");
    let history = home.join("sessions/2026/10/06/example.jsonl");
    std::fs::create_dir_all(history.parent().unwrap()).unwrap();
    std::fs::write(
        &history,
        r#"{"type":"session_meta","payload":{"id":"caller","cwd":"/launch/parent"}}
"#,
    )
    .unwrap();
    let cab = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_cab"))
            .current_dir(root.path())
            .arg("-C")
            .arg(&checkout)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("CODEX_HOME", &home)
            .env("CODEX_THREAD_ID", "caller")
            .env("CLAUDE_CONFIG_DIR", root.path().join("claude"))
            .output()
            .unwrap()
    };
    let out = cab(&["change", "create", "feature", "--parent", "main"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(cab(&["session", "link"]).status.success());
    let refused = cab(&["session", "link", "--change", "feature"]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("unlink it first"));
    assert!(cab(&["session", "unlink"]).status.success());
    assert!(cab(&["session", "link", "--change", "feature"]).status.success());
    std::fs::remove_file(history).unwrap();
    assert!(cab(&["session", "unlink", "--change", "feature"]).status.success());
}
