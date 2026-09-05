//! The home page: what each section includes for a viewer and how the page draws it.

use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

fn home(fixture: &Fixture) -> String { fixture.cabaret.home_page(&alice()).unwrap().to_string() }

#[test]
fn owned_changes_plus_open_ancestors_as_context() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("infra", "main", &bob());
    fixture.create("feature", "infra", &alice());
    fixture.create("unrelated", "main", &bob());
    fixture.cabaret.set_title(&id("feature"), Some("My feature".into())).unwrap();
    expect![[r"
        Owned
        ◌   infra
        ╰─○   feature  My feature

        Workspaces
        no changes checked out in a workspace
    "]]
    .assert_eq(&home(&fixture));
}

#[test]
fn trunk_and_archived_changes_are_never_drawn() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("base", "main", &alice());
    fixture.create("top", "base", &alice());
    fixture.cabaret.archive(&id("base")).unwrap();
    expect![[r"
        Owned
        ○   top

        Workspaces
        no changes checked out in a workspace
    "]]
    .assert_eq(&home(&fixture));
}

#[test]
fn workspaces_section_shows_checked_out_changes_with_context() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("infra", "main", &bob());
    fixture.create("feature", "infra", &alice());
    fixture.create("theirs", "main", &bob());
    fixture.checkout("theirs");
    fixture.add_workspace("feature");
    expect![[r"
        Owned
        ◌   infra
        ╰─○   feature

        Workspaces
        ◌   infra
        ╰─○   feature
        ○   theirs
    "]]
    .assert_eq(&home(&fixture));
}

/// An archived change hangs off what it landed into; an open change hangs past an archived parent.
#[test]
fn workspaces_section_keeps_archived_changes() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("done", "main", &alice());
    fixture.create("after-done", "done", &alice());
    fixture.cabaret.archive(&id("done")).unwrap();
    fixture.checkout("done");
    fixture.add_workspace("after-done");
    expect![[r"
        Owned
        ○   after-done

        Workspaces
        ○   after-done
        ○   done
    "]]
    .assert_eq(&home(&fixture));
}

#[test]
fn nothing_owned_says_so() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("theirs", "main", &bob());
    expect![[r"
        Owned
        no open changes owned by alice@example.com

        Workspaces
        no changes checked out in a workspace
    "]]
    .assert_eq(&home(&fixture));
}
