use std::{fmt::Write, fs, path::Path};

use cabaret_agents::{ClaudeCode, Session};
use expect_test::expect;

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn render(sessions: &[Session]) -> String {
    let mut out = String::new();
    for Session { id, title, last_active, live } in sessions {
        let live = live.map_or("-".to_owned(), |status| format!("{status:?}").to_lowercase());
        writeln!(out, "{id} {} {live} {title:?}", last_active.0).unwrap();
    }
    out
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let feature = projects.join("-repo-feature-x");
    write(
        &feature.join("titled.jsonl"),
        &[
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>ignored</local-command-caveat>"}}"#,
            r#"{"type":"user","timestamp":"1970-01-01T00:16:00Z","message":{"role":"user","content":"fix the parser"}}"#,
            r#"{"type":"assistant","timestamp":"1970-01-01T00:16:40Z","message":{"role":"assistant","content":[{"type":"text","text":"On it."}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"system","subtype":"away_summary","timestamp":"1970-01-02T00:00:00Z"}"#,
            r#"{"type":"ai-title","aiTitle":"Parser fix"}"#,
        ]
        .join("\n"),
    );
    write(
        &feature.join("untitled.jsonl"),
        &[
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","timestamp":"1970-01-01T00:33:20.500Z","message":{"role":"user","content":"make it compile\nplease"}}"#,
            r#"{"type":"some-future-line-type","payload":42}"#,
            r#"{"type":"user","timestamp":"1970-01-01T00:4"#,
        ]
        .join("\n"),
    );
    write(
        &feature.join("empty.jsonl"),
        r#"{"type":"system","subtype":"local_command","timestamp":"1970-01-01T01:00:00Z","content":"/usage"}"#,
    );
    write(
        &projects.join("-repo-feature-x-2").join("sibling.jsonl"),
        r#"{"type":"user","timestamp":"1970-01-01T00:50:00Z","message":{"role":"user","content":"sibling"}}"#,
    );
    let sessions = dir.path().join("sessions");
    write(&sessions.join("1.json"), r#"{"pid":1,"sessionId":"untitled","status":"busy"}"#);
    write(&sessions.join("1.key"), "not json");
    write(&sessions.join("2.json"), r#"{"pid":2,"sessionId":"sibling","status":"compacting"}"#);
    write(&sessions.join("3.json"), r#"{"pid":3,"sessionId":"titled"}"#);
    dir
}

#[test]
fn sessions_are_those_launched_from_directory_ordered_by_activity() {
    let dir = fixture();
    let claude = ClaudeCode::new(dir.path().to_owned());
    expect![[r#"
        untitled 2000500 busy Some("make it compile")
        titled 1000000 unknown Some("Parser fix")
    "#]]
    .assert_eq(&render(&claude.sessions_in(Path::new("/repo/feature-x")).unwrap()));
    expect![[r#"
        sibling 3000000 unknown Some("sibling")
    "#]]
    .assert_eq(&render(&claude.sessions_in(Path::new("/repo/feature-x-2")).unwrap()));
    expect![[""]].assert_eq(&render(&claude.sessions_in(Path::new("/repo")).unwrap()));
}

#[test]
fn missing_config_dir_has_no_sessions() {
    let claude = ClaudeCode::new(Path::new("/nonexistent/.claude").to_owned());
    assert!(claude.sessions_in(Path::new("/repo")).unwrap().is_empty());
}
