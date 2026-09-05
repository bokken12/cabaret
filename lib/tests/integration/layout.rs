//! Making repositories: empty ones and clones in an empty project directory, with room for one
//! workspace per change, and empty ones in a directory with contents, as its main workspace.

use std::fs;

use cabaret_lib::Cabaret;
use expect_test::expect;

use super::{
    fixture::{Fixture, id, worktree},
    workspace::two_changes,
};

fn workspaces(cabaret: &Cabaret) -> String { format!("{:?}", cabaret.workspaces().unwrap()) }

fn error(result: cabaret_lib::Result<()>) -> String { format!("{:?}", result.unwrap_err()) }

/// Commit an empty tree as `HEAD`'s first commit in the workspace at `path`, as a user would.
fn first_commit(path: &std::path::Path) {
    let repo = gix::open(path).unwrap();
    let tree = repo.empty_tree().id;
    let author = gix::actor::Signature {
        name: "Alice Test".into(),
        email: "alice@example.com".into(),
        time: gix::date::Time { seconds: 978_307_200, offset: 0 },
    };
    repo.commit_as(
        author.to_ref(&mut gix::date::parse::TimeBuf::default()),
        author.to_ref(&mut gix::date::parse::TimeBuf::default()),
        "HEAD",
        "first",
        tree,
        [] as [gix::ObjectId; 0],
    )
    .unwrap();
}

#[test]
fn init_makes_empty_project_directory() {
    let fixture = Fixture::new();
    Cabaret::init(&fixture.path("new"), None).unwrap();
    let cabaret = Cabaret::open(fixture.path("new")).unwrap();
    expect![[r#"
        .bare
        .git"#]]
    .assert_eq(&fixture.listing("new"));
    expect!["{}"].assert_eq(&workspaces(&cabaret));
    expect![[r#"
        gitdir: ./.bare
    "#]]
    .assert_eq(&fs::read_to_string(fixture.path("new/.git")).unwrap());
}

#[test]
fn init_makes_main_workspace_of_directory_with_contents() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.path("here")).unwrap();
    fs::write(fixture.path("here/notes.txt"), "notes\n").unwrap();
    Cabaret::init(&fixture.path("here"), None).unwrap();
    let cabaret = Cabaret::open(fixture.path("here")).unwrap();
    expect![[r#"
        .git
        notes.txt"#]]
    .assert_eq(&fixture.listing("here"));
    expect![[r#"{"main": Some("main")}"#]].assert_eq(&workspaces(&cabaret));
    first_commit(&fixture.path("here"));
    expect![[r#"
        clean
        notes.txt "notes\n"
    "#]]
    .assert_eq(&worktree(&gix::open(fixture.path("here")).unwrap()));
}

#[test]
fn clone_makes_project_directory_with_remote_branches() {
    let fixture = two_changes();
    Cabaret::init(&fixture.path("clone"), Some(fixture.path("main").to_str().unwrap())).unwrap();
    let cabaret = Cabaret::open(fixture.path("clone")).unwrap();
    expect![[r#"
        .bare
        .git"#]]
    .assert_eq(&fixture.listing("clone"));
    expect!["{}"].assert_eq(&workspaces(&cabaret));
    let repo = gix::open(fixture.path("clone")).unwrap();
    let mut refs: Vec<String> =
        repo.references().unwrap().all().unwrap().map(|r| r.unwrap().name().as_bstr().to_string()).collect();
    refs.sort();
    expect![[r#"
        refs/heads/one
        refs/remotes/origin/HEAD
        refs/remotes/origin/main
        refs/remotes/origin/one
        refs/remotes/origin/two"#]]
    .assert_eq(&refs.join("\n"));

    let path = cabaret.workspace_add(id("one"), None).unwrap();
    expect!["clone/one"].assert_eq(&fixture.relative(&path));
    expect![[r#"
        clean
        main.txt "main\n"
        one.txt "one\n"
    "#]]
    .assert_eq(&worktree(&gix::open(&path).unwrap()));
}

#[test]
fn clone_refuses_occupied_directory() {
    let fixture = two_changes();
    let source = fixture.path("main");
    expect!["<root>/main is not empty"]
        .assert_eq(&fixture.redact(&error(Cabaret::init(&source, Some(source.to_str().unwrap())))));
}
