//! Which Claude Code sessions a change shows: those launched in its workspace, which outlive
//! the workspace itself.

use std::{fs, path::Path};

use cabaret_lib::{ClaudeCode, WorkspaceId};
use expect_test::expect;

use super::{
    fixture::{Fixture, id},
    workspace::two_changes,
};

/// Record a session launched from `dir` whose first prompt is `prompt`, where Claude Code would:
/// under a project folder named for `dir` with everything but ASCII alphanumerics as `-`.
fn launch(claude_dir: &Path, dir: &Path, prompt: &str) {
    let folder: String =
        dir.to_str().unwrap().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let project = claude_dir.join("projects").join(folder);
    fs::create_dir_all(&project).unwrap();
    let line = format!(
        r#"{{"type":"user","timestamp":"1970-01-01T00:00:01Z","message":{{"role":"user","content":{prompt:?}}}}}"#
    );
    fs::write(project.join(format!("{prompt}.jsonl")), line).unwrap();
}

fn titles(fixture: &Fixture, claude: &ClaudeCode, change: &str) -> String {
    let sessions = fixture.cabaret.sessions(&id(change), claude).unwrap();
    sessions.iter().map(|session| session.title.clone().unwrap()).collect::<Vec<_>>().join("\n")
}

#[test]
fn sessions_outlive_the_workspace_they_worked_in() {
    let fixture = two_changes();
    let claude_dir = fixture.path("claude");
    let claude = ClaudeCode::new(claude_dir.clone());
    let two = fixture.add_workspace("two");
    launch(&claude_dir, two.workdir().unwrap(), "worked on two");
    expect!["worked on two"].assert_eq(&titles(&fixture, &claude, "two"));

    fixture.cabaret.workspace_remove(WorkspaceId::Linked("main-two".into()).to_ref()).unwrap();
    expect!["worked on two"].assert_eq(&titles(&fixture, &claude, "two"));
}

#[test]
fn sessions_follow_a_workspace_placed_elsewhere() {
    let fixture = two_changes();
    let claude_dir = fixture.path("claude");
    let claude = ClaudeCode::new(claude_dir.clone());
    launch(&claude_dir, &fixture.path("main-two"), "in the default location");
    let elsewhere = fixture.cabaret.workspace_add(id("two"), Some(fixture.path("elsewhere"))).unwrap();
    launch(&claude_dir, &elsewhere, "elsewhere");
    expect!["elsewhere"].assert_eq(&titles(&fixture, &claude, "two"));
}

#[test]
fn a_change_never_checked_out_has_no_sessions() {
    let fixture = two_changes();
    let claude = ClaudeCode::new(fixture.path("claude"));
    expect![""].assert_eq(&titles(&fixture, &claude, "two"));
}
