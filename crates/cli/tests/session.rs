use std::process::Command;

#[test]
fn capabilities_and_help_explain_claude_limitations_without_a_repository() {
    let output = Command::new(env!("CARGO_BIN_EXE_cab"))
        .current_dir(std::env::temp_dir())
        .args(["session", "providers"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("claude:"));
    assert!(text.contains("NOT IMPLEMENTED"));
    assert!(text.contains("--id and --directory"));
    assert!(text.contains("codex:"));
    let output = Command::new(env!("CARGO_BIN_EXE_cab"))
        .args(["session", "link", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("Claude automatic identification is not implemented")
    );
}
