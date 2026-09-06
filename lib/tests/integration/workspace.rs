//! Workspaces: which working directories exist and which change each holds, and adding,
//! switching, and removing them.

use cabaret_lib::{Cabaret, WorkspaceId};
use expect_test::expect;

use super::fixture::{Fixture, alice, id, worktree};

fn workspaces(fixture: &Fixture) -> String { format!("{:?}", fixture.cabaret.workspaces().unwrap()) }

fn linked(name: &str) -> WorkspaceId { WorkspaceId::Linked(name.into()) }

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
    let path = fixture.cabaret.workspace_add(id("two"), None).unwrap();
    expect!["main-two"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"main": Some("one"), "main-two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"Some("main-two")"#]].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
    expect![[r#"
        clean
        main.txt "main\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&worktree(&gix::open(&path).unwrap()));
}

#[test]
fn add_at_path_names_workspace_after_it() {
    let fixture = two_changes();
    let path = fixture.cabaret.workspace_add(id("two"), Some(fixture.path("elsewhere"))).unwrap();
    expect!["elsewhere"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"main": Some("one"), "elsewhere": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    assert_eq!(fixture.cabaret.workspace_path(linked("elsewhere").to_ref()).unwrap(), path);
    assert_eq!(fixture.cabaret.workspace_at(&path).unwrap(), linked("elsewhere"));
}

#[test]
fn add_refuses_change_already_checked_out() {
    let fixture = two_changes();
    let error = fixture.cabaret.workspace_add(id("one"), None).unwrap_err();
    expect!["one is already checked out in workspace main"].assert_eq(&format!("{error:?}"));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    assert!(!fixture.path("main-one").exists());
}

#[test]
fn switch_swaps_files_and_head() {
    let fixture = two_changes();
    fixture.cabaret.workspace_switch(WorkspaceId::Main.to_ref(), id("two")).unwrap();
    expect![[r#"{"main": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"
        clean
        main.txt "main\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn switch_refuses_dirty_workspace() {
    let fixture = two_changes();
    fixture.write("one.txt", "edited\n");
    let error = fixture.cabaret.workspace_switch(WorkspaceId::Main.to_ref(), id("two")).unwrap_err();
    expect!["workspace main has local changes"].assert_eq(&format!("{error:?}"));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"
        dirty
        main.txt "main\n"
        one.txt "edited\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn switch_refuses_change_checked_out_elsewhere() {
    let fixture = two_changes();
    fixture.add_workspace("two");
    let error = fixture.cabaret.workspace_switch(WorkspaceId::Main.to_ref(), id("two")).unwrap_err();
    expect!["two is already checked out in workspace main-two"].assert_eq(&format!("{error:?}"));
    expect![[r#"{"main": Some("one"), "main-two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn remove_deletes_clean_workspace() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    fixture.cabaret.workspace_remove(linked("main-two").to_ref()).unwrap();
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    expect!["None"].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
    assert!(!two.workdir().unwrap().exists());
    assert!(!two.git_dir().exists());
}

#[test]
fn remove_refuses_dirty_workspace() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    std::fs::write(two.workdir().unwrap().join("two.txt"), "edited\n").unwrap();
    let error = fixture.cabaret.workspace_remove(linked("main-two").to_ref()).unwrap_err();
    expect!["workspace main-two has local changes"].assert_eq(&format!("{error:?}"));
    expect![[r#"
        dirty
        main.txt "main\n"
        two.txt "edited\n"
    "#]]
    .assert_eq(&worktree(&two));
}

#[test]
fn remove_refuses_workspace_with_untracked_files() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    std::fs::write(two.workdir().unwrap().join("scratch.txt"), "scratch\n").unwrap();
    let error = fixture.cabaret.workspace_remove(linked("main-two").to_ref()).unwrap_err();
    expect!["workspace main-two has untracked files"].assert_eq(&format!("{error:?}"));
    assert!(two.workdir().unwrap().join("scratch.txt").exists());
}

#[test]
fn main_workspace_cannot_be_removed() {
    let fixture = two_changes();
    let error = fixture.cabaret.workspace_remove(WorkspaceId::Main.to_ref()).unwrap_err();
    expect!["the main workspace cannot be removed"].assert_eq(&format!("{error:?}"));
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
    let path = fixture.cabaret.workspace_add(id("two"), None).unwrap();
    expect!["project/two"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"Some("two")"#]].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
    expect![[r#"
        clean
        main.txt "main\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&worktree(&gix::open(&path).unwrap()));
}

#[test]
fn add_names_workspace_with_tilde_for_slash() {
    let fixture = two_changes_in(Fixture::bare());
    fixture.create("feature/login", "main", &alice());
    let path = fixture.cabaret.workspace_add(id("feature/login"), None).unwrap();
    expect!["project/feature~login"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"feature~login": Some("feature/login")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn bare_add_from_inside_workspace_lands_beside_it() {
    let fixture = two_changes_in(Fixture::bare());
    let two = fixture.cabaret.workspace_add(id("two"), None).unwrap();
    let path = Cabaret::open(&two).unwrap().workspace_add(id("one"), None).unwrap();
    expect!["project/one"].assert_eq(&fixture.relative(&path));
    expect![[r#"{"one": Some("one"), "two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn prune_removes_workspaces_of_archived_changes() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    fixture.cabaret.archive(&id("two")).unwrap();
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
    fixture.cabaret.archive(&id("two")).unwrap();
    std::fs::write(two.workdir().unwrap().join("two.txt"), "edited\n").unwrap();
    let prune = fixture.cabaret.workspace_prune().unwrap();
    expect![[r#"Prune { removed: {}, kept: {"main-two": "workspace main-two has local changes"} }"#]]
        .assert_eq(&format!("{prune:?}"));
    expect![[r#"{"main": Some("one"), "main-two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
}

#[test]
fn prune_keeps_main_workspace() {
    let fixture = two_changes();
    fixture.cabaret.archive(&id("one")).unwrap();
    let prune = fixture.cabaret.workspace_prune().unwrap();
    expect![[r#"Prune { removed: {}, kept: {"main": "the main workspace cannot be removed"} }"#]]
        .assert_eq(&format!("{prune:?}"));
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
}
