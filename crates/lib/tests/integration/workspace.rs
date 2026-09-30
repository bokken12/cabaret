//! Workspaces: which working directories exist and which change each holds, and adding,
//! switching, and removing them.

use cabaret_lib::{
    Error, WorkspaceId,
    safeguard::{Allow, SafeguardKind},
};
use expect_test::expect;

use super::fixture::{Fixture, alice, id, open_cabaret, open_repo, worktree};

fn workspaces(fixture: &Fixture) -> String { format!("{:?}", fixture.cabaret.workspaces().unwrap()) }

fn linked(name: &str) -> WorkspaceId { WorkspaceId::Linked(name.into()) }

fn shown(attempt: cabaret_lib::Result<()>) -> String {
    match attempt {
        Ok(()) => "done".to_owned(),
        Err(Error::Refused(refused)) => {
            let shown: Vec<String> = refused.iter().map(ToString::to_string).collect();
            format!("refused: {}", shown.join("; "))
        }
        Err(error) => format!("error: {error:?}"),
    }
}

/// Switch the main workspace to `change`.
fn switch(fixture: &Fixture, change: &str, allow: &Allow) -> String {
    shown(fixture.cabaret.workspace_switch(WorkspaceId::Main.to_ref(), &id(change), allow))
}

fn remove(fixture: &Fixture, workspace: &str, allow: &Allow) -> String {
    shown(fixture.cabaret.workspace_remove(linked(workspace).to_ref(), allow))
}

/// `one` and `two` on `main` in `fixture`, each adding a file of its own; nothing is checked out.
pub fn two_changes_in(fixture: Fixture) -> Fixture {
    fixture.root("main", &[("main.txt", "main\n")]);
    fixture.create("one", "main", &alice());
    fixture.commit("one", &[("one.txt", "one\n")]);
    fixture.create("two", "main", &alice());
    fixture.commit("two", &[("two.txt", "two\n")]);
    fixture
}

/// [`two_changes_in`] a repository with a main workspace, where `one` is checked out.
pub fn two_changes() -> Fixture {
    let fixture = two_changes_in(Fixture::new());
    fixture.checkout("one");
    fixture
}

#[test]
fn main_workspace_holds_checked_out_change() {
    let fixture = two_changes();
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"Some("main")"#]].assert_eq(&format!("{:?}", fixture.snapshot("one").workspace));
    expect!["None"].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
}

#[test]
fn detached_head_holds_no_change() {
    let fixture = two_changes();
    fixture.detach("one");
    expect![[r#"{"main": None}"#]].assert_eq(&workspaces(&fixture));
    expect!["None"].assert_eq(&format!("{:?}", fixture.snapshot("one").workspace));
}

#[test]
fn add_makes_workspace_beside_main() {
    let fixture = two_changes();
    let path = fixture.cabaret.workspace_add(&id("two"), None).unwrap();
    expect!["main-two"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"main": Some("one"), "main-two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"Some("main-two")"#]].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
    expect![[r#"
        clean
        main.txt "main\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&worktree(&open_repo(&path)));
}

#[test]
fn add_at_path_names_workspace_after_it() {
    let fixture = two_changes();
    let path = fixture.cabaret.workspace_add(&id("two"), Some(fixture.path("elsewhere"))).unwrap();
    expect!["elsewhere"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"main": Some("one"), "elsewhere": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    assert_eq!(fixture.cabaret.workspace_path(linked("elsewhere").to_ref()).unwrap(), path);
    assert_eq!(fixture.cabaret.workspace_at(&path).unwrap(), linked("elsewhere"));
}

#[test]
fn add_refuses_change_already_checked_out() {
    let fixture = two_changes();
    let error = fixture.cabaret.workspace_add(&id("one"), None).unwrap_err();
    expect!["one is already checked out in workspace main"].assert_eq(&format!("{error:?}"));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    assert!(!fixture.path("main-one").exists());
}

#[test]
fn switch_swaps_files_and_head() {
    let fixture = two_changes();
    expect!["done"].assert_eq(&switch(&fixture, "two", &Allow::default()));
    expect![[r#"{"main": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"
        clean
        main.txt "main\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn switch_refuses_dirty_workspace_unless_allowed() {
    let fixture = two_changes();
    fixture.write("one.txt", "edited\n");
    fixture.write("scratch.txt", "scratch\n");
    expect!["refused: workspace main has uncommitted changes"].assert_eq(&switch(&fixture, "two", &Allow::default()));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    expect!["done"].assert_eq(&switch(&fixture, "two", &Allow::from_iter([SafeguardKind::Uncommitted])));
    expect![[r#"
        clean
        main.txt "main\n"
        scratch.txt "scratch\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn switch_keeps_untracked_files() {
    let fixture = two_changes();
    fixture.write("scratch.txt", "scratch\n");
    expect!["done"].assert_eq(&switch(&fixture, "two", &Allow::default()));
    expect![[r#"
        clean
        main.txt "main\n"
        scratch.txt "scratch\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn switch_refuses_change_checked_out_elsewhere() {
    let fixture = two_changes();
    fixture.add_workspace("two");
    expect!["error: two is already checked out in workspace main-two"].assert_eq(&switch(
        &fixture,
        "two",
        &Allow::default(),
    ));
    expect![[r#"{"main": Some("one"), "main-two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn remove_deletes_clean_workspace() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    expect!["done"].assert_eq(&remove(&fixture, "main-two", &Allow::default()));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    expect!["None"].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
    assert!(!two.workdir().unwrap().exists());
    assert!(!two.git_dir().exists());
}

#[test]
fn remove_refuses_dirty_workspace_unless_allowed() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    std::fs::write(two.workdir().unwrap().join("two.txt"), "edited\n").unwrap();
    expect!["refused: workspace main-two has uncommitted changes"].assert_eq(&remove(
        &fixture,
        "main-two",
        &Allow::default(),
    ));
    expect![[r#"
        dirty
        main.txt "main\n"
        two.txt "edited\n"
    "#]]
    .assert_eq(&worktree(&two));
    expect!["done"].assert_eq(&remove(&fixture, "main-two", &Allow::from_iter([SafeguardKind::Uncommitted])));
    assert!(!two.workdir().unwrap().exists());
}

#[test]
fn remove_refuses_workspace_with_untracked_files() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    std::fs::write(two.workdir().unwrap().join("scratch.txt"), "scratch\n").unwrap();
    expect!["refused: workspace main-two has uncommitted changes"].assert_eq(&remove(
        &fixture,
        "main-two",
        &Allow::default(),
    ));
    assert!(two.workdir().unwrap().join("scratch.txt").exists());
}

/// A parent that cannot lose the directory stands in for a running tool writing into it
/// mid-removal: the files go, but the directory itself stays.
#[test]
fn remove_failing_partway() {
    use std::{fs, os::unix::fs::PermissionsExt};

    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    let workdir = two.workdir().unwrap().to_owned();
    let parent = workdir.parent().unwrap();
    fs::set_permissions(parent, fs::Permissions::from_mode(0o555)).unwrap();
    let error = remove(&fixture, "main-two", &Allow::default());
    fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
    let error = error.replace(&workdir.display().to_string(), "<workdir>");
    let left: Vec<_> = fs::read_dir(&workdir).unwrap().map(|entry| entry.unwrap().file_name()).collect();
    expect![[r#"
        error: workspace main-two is removed, but deleting <workdir> failed: Permission denied (os error 13)
        {"main": Some("one")}
        []"#]]
    .assert_eq(&format!("{error}\n{}\n{left:?}", workspaces(&fixture)));
}

#[test]
fn main_workspace_cannot_be_removed() {
    let fixture = two_changes();
    fixture.write("scratch.txt", "scratch\n");
    expect!["error: the main workspace cannot be removed"]
        .assert_eq(&shown(fixture.cabaret.workspace_remove(WorkspaceId::Main.to_ref(), &Allow::default())));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn bare_repository_has_no_main_workspace() {
    let fixture = two_changes_in(Fixture::bare());
    expect![[r#"{}"#]].assert_eq(&workspaces(&fixture));
    expect!["None"].assert_eq(&format!("{:?}", fixture.snapshot("one").workspace));
}

#[test]
fn bare_add_makes_workspace_beside_git_dir() {
    let fixture = two_changes_in(Fixture::bare());
    let path = fixture.cabaret.workspace_add(&id("two"), None).unwrap();
    expect!["project/two"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"Some("two")"#]].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
    expect![[r#"
        clean
        main.txt "main\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&worktree(&open_repo(&path)));
}

#[test]
fn add_names_workspace_with_tilde_for_slash() {
    let fixture = two_changes_in(Fixture::bare());
    fixture.create("feature/login", "main", &alice());
    let path = fixture.cabaret.workspace_add(&id("feature/login"), None).unwrap();
    expect!["project/feature~login"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"feature~login": Some("feature/login")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn bare_add_from_inside_workspace_lands_beside_it() {
    let fixture = two_changes_in(Fixture::bare());
    let two = fixture.cabaret.workspace_add(&id("two"), None).unwrap();
    let path = open_cabaret(&two).workspace_add(&id("one"), None).unwrap();
    expect!["project/one"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"one": Some("one"), "two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn workspace_outlives_workspace_it_was_added_from() {
    let fixture = two_changes_in(Fixture::bare());
    let two = fixture.cabaret.workspace_add(&id("two"), None).unwrap();
    let one = open_cabaret(&two).workspace_add(&id("one"), None).unwrap();
    expect!["done"].assert_eq(&remove(&fixture, "two", &Allow::default()));
    expect![[r#""one""#]].assert_eq(&format!("{:?}", open_cabaret(&one).workspace_current().unwrap()));
}

fn dedicated(fixture: &Fixture, workspace: &WorkspaceId) -> bool {
    fixture.cabaret.workspace_is_dedicated(workspace.to_ref()).unwrap()
}

#[test]
fn workspace_beside_main_is_dedicated_and_main_is_not() {
    let fixture = two_changes();
    fixture.cabaret.workspace_add(&id("two"), None).unwrap();
    assert!(!dedicated(&fixture, &WorkspaceId::Main));
    assert!(dedicated(&fixture, &linked("main-two")));
}

#[test]
fn workspace_at_chosen_path_is_not_dedicated() {
    let fixture = two_changes();
    fixture.cabaret.workspace_add(&id("two"), Some(fixture.path("elsewhere"))).unwrap();
    assert!(!dedicated(&fixture, &linked("elsewhere")));
}

#[test]
fn detached_workspace_is_not_dedicated() {
    let fixture = two_changes();
    fixture.detach("one");
    assert!(!dedicated(&fixture, &WorkspaceId::Main));
}

#[test]
fn bare_workspaces_are_dedicated() {
    let fixture = two_changes_in(Fixture::bare());
    fixture.cabaret.workspace_add(&id("two"), None).unwrap();
    assert!(dedicated(&fixture, &linked("two")));
}

#[test]
fn prune_removes_workspaces_of_archived_changes() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    fixture.archive("two");
    let prune = fixture.cabaret.workspace_prune().unwrap();
    expect![[r#"Prune { removed: {"main-two"}, kept: {} }"#]].assert_eq(&format!("{prune:?}"));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    assert!(!two.workdir().unwrap().exists());
    assert!(!two.git_dir().exists());
}

#[test]
fn prune_leaves_open_changes_checked_out() {
    let fixture = two_changes();
    fixture.add_workspace("two");
    let prune = fixture.cabaret.workspace_prune().unwrap();
    expect!["Prune { removed: {}, kept: {} }"].assert_eq(&format!("{prune:?}"));
    expect![[r#"{"main": Some("one"), "main-two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn prune_keeps_dirty_workspace() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    fixture.archive("two");
    std::fs::write(two.workdir().unwrap().join("two.txt"), "edited\n").unwrap();
    let prune = fixture.cabaret.workspace_prune().unwrap();
    expect![[r#"Prune { removed: {}, kept: {"main-two": "workspace main-two has local changes"} }"#]]
        .assert_eq(&format!("{prune:?}"));
    expect![[r#"{"main": Some("one"), "main-two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn prune_keeps_main_workspace() {
    let fixture = two_changes();
    fixture.archive("one");
    let prune = fixture.cabaret.workspace_prune().unwrap();
    expect![[r#"Prune { removed: {}, kept: {"main": "the main workspace cannot be removed"} }"#]]
        .assert_eq(&format!("{prune:?}"));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
}
