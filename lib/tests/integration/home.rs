//! The home page: what each section includes for a viewer and how the page draws it.

use cabaret_lib::RepoPath;
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

fn home(fixture: &Fixture) -> String { fixture.cabaret.home_page(&alice()).unwrap().to_string() }

/// Mark every file alice has left to review in `change` reviewed at its tip.
fn mark_all(fixture: &Fixture, change: &str) {
    let files: Vec<RepoPath> =
        fixture.cabaret.review_files(&id(change), &[]).unwrap().iter().map(|file| file.path().clone()).collect();
    fixture.cabaret.mark(&id(change), &files, None).unwrap();
}

/// Trunk is drawn only where it is selected, as the fixture's main workspace has it checked out;
/// as mere context under every stack it is dropped.
#[test]
fn owned_changes_plus_open_ancestors_as_context() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("infra", "main", &bob());
    fixture.create("feature", "infra", &alice());
    fixture.create("unrelated", "main", &bob());
    fixture.cabaret.set_title(&id("feature"), Some("My feature".into())).unwrap();
    expect![[r"
        To review
        nothing awaiting review by alice@example.com

        Owned
        ◌   infra
        ╰─○   feature  My feature

        Workspaces
        ○   main
    "]]
    .assert_eq(&home(&fixture));
}

#[test]
fn archived_changes_are_never_drawn_as_context() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("base", "main", &alice());
    fixture.create("top", "base", &alice());
    fixture.cabaret.archive(&id("base")).unwrap();
    expect![[r"
        To review
        nothing awaiting review by alice@example.com

        Owned
        ○   top

        Workspaces
        ○   main
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
        To review
        nothing awaiting review by alice@example.com

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
        To review
        nothing awaiting review by alice@example.com

        Owned
        ○   after-done

        Workspaces
        ○   after-done
        ○   done
    "]]
    .assert_eq(&home(&fixture));
}

/// Once selected, trunk roots the stacks that target it like any other change.
#[test]
fn checked_out_trunk_roots_its_stacks() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("feature", "main", &bob());
    fixture.create("other", "main", &bob());
    fixture.add_workspace("feature");
    fixture.add_workspace("other");
    expect![[r"
        To review
        nothing awaiting review by alice@example.com

        Owned
        no open changes owned by alice@example.com

        Workspaces
        ○   main
        ├─○   feature
        ╰─○   other
    "]]
    .assert_eq(&home(&fixture));
}

#[test]
fn nothing_owned_says_so() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("theirs", "main", &bob());
    expect![[r"
        To review
        nothing awaiting review by alice@example.com

        Owned
        no open changes owned by alice@example.com

        Workspaces
        ○   main
    "]]
    .assert_eq(&home(&fixture));
}

/// Owners are to review every file of their changes, so one whose files they have not marked at
/// the tip awaits them; changes owned by others do not, whatever their state.
#[test]
fn owned_changes_with_unmarked_files_await_review() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("infra", "main", &bob());
    fixture.commit("infra", &[("infra.txt", "infra\n")]);
    fixture.create("feature", "infra", &alice());
    fixture.commit("feature", &[("feature.txt", "feature\n")]);
    fixture.create("empty", "main", &alice());
    expect![[r"
        To review
        ◌   infra
        ╰─○   feature

        Owned
        ○   empty
        ◌   infra
        ╰─○   feature

        Workspaces
        ○   main
    "]]
    .assert_eq(&home(&fixture));
    mark_all(&fixture, "feature");
    expect![[r"
        To review
        nothing awaiting review by alice@example.com

        Owned
        ○   empty
        ◌   infra
        ╰─○   feature

        Workspaces
        ○   main
    "]]
    .assert_eq(&home(&fixture));
    fixture.commit("feature", &[("feature.txt", "feature 2\n")]);
    expect![[r"
        To review
        ◌   infra
        ╰─○   feature

        Owned
        ○   empty
        ◌   infra
        ╰─○   feature

        Workspaces
        ○   main
    "]]
    .assert_eq(&home(&fixture));
}

/// A clean rebase moves the tip to what the reviewed tip merged with the new base already is,
/// so nothing new awaits review; a conflicting one commits resolution to read.
#[test]
fn a_rebase_awaits_review_only_when_it_conflicted() {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("feature", "main", &alice());
    fixture.commit("feature", &[("greeting.txt", "hi\n")]);
    mark_all(&fixture, "feature");
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture.cabaret.rebase(&id("feature"), None).unwrap();
    expect![[r"
        To review
        nothing awaiting review by alice@example.com

        Owned
        ○   feature

        Workspaces
        ○   main
    "]]
    .assert_eq(&home(&fixture));
    fixture.commit("main", &[("greeting.txt", "hey\n")]);
    fixture.cabaret.rebase(&id("feature"), None).unwrap();
    expect![[r"
        To review
        ○   feature

        Owned
        ○   feature

        Workspaces
        ○   main
    "]]
    .assert_eq(&home(&fixture));
}
