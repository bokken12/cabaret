//! The home page: what each section includes for a viewer and how the page draws it.

use std::collections::BTreeSet;

use cabaret_lib::Reviewing;
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

fn home(fixture: &Fixture) -> String { fixture.cabaret.home_page(&alice()).unwrap().to_string() }

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
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        ◌   infra
        ╰─○   My feature

        Workspaces
        ○   main
    "#]]
    .assert_eq(&home(&fixture));
}

#[test]
fn landed_parent_stays_above_children_until_they_are_fixed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("base", "main", &alice());
    fixture.commit("base", &[("base.txt", "base\n")]);
    fixture.create("left", "base", &alice());
    fixture.create("right", "base", &alice());
    fixture.mark_all("base");
    fixture.endorse("base");
    fixture.cabaret.land(&id("base"), &BTreeSet::new()).unwrap();
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        ◌   base (archived)
        ├─○   left
        ╰─○   right

        Workspaces
        ○   main
    "#]]
    .assert_eq(&home(&fixture));
    let next_step = |change: &str| {
        let page = fixture.cabaret.show_page(&id(change)).unwrap().to_string();
        page.lines().find(|line| line.starts_with("Next step: ")).unwrap().to_owned()
    };
    expect!["Next step: fix parents"].assert_eq(&next_step("left"));
    fixture.cabaret.fix_parents(&id("left")).unwrap();
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        ◌   base (archived)
        ╰─○   right
        ○   left

        Workspaces
        ○   main
    "#]]
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
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        ◌   infra
        ╰─○   feature

        Workspaces
        ◌   infra
        ╰─○   feature
        ○   theirs
    "#]]
    .assert_eq(&home(&fixture));
}

/// An archived change hangs off what it landed into.
#[test]
fn workspaces_section_keeps_archived_changes() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("done", "main", &alice());
    fixture.create("after-done", "done", &alice());
    fixture.archive("done");
    fixture.checkout("done");
    fixture.add_workspace("after-done");
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        ◌   done (archived)
        ╰─○   after-done

        Workspaces
        ○   done (archived)
        ╰─○   after-done
    "#]]
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
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        no open changes owned by alice@example.com

        Workspaces
        ○   main
        ├─○   feature
        ╰─○   other
    "#]]
    .assert_eq(&home(&fixture));
}

#[test]
fn nothing_owned_says_so() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("theirs", "main", &bob());
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        no open changes owned by alice@example.com

        Workspaces
        ○   main
    "#]]
    .assert_eq(&home(&fixture));
}

/// Owners are to review every file of their changes, so one up for review whose files they have
/// not marked at the tip awaits them; changes owned by others do not, whatever their state.
#[test]
fn owned_changes_with_unmarked_files_await_review() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("infra", "main", &bob());
    fixture.commit("infra", &[("infra.txt", "infra\n")]);
    fixture.create("feature", "infra", &alice());
    fixture.commit("feature", &[("feature.txt", "feature\n")]);
    fixture.request_review("feature");
    fixture.create("empty", "main", &alice());
    expect![[r#"
        Review
        ◌   infra
        ╰─○   feature

        Owned
        ○   empty
        ◌   infra
        ╰─○   feature

        Workspaces
        ○   main
    "#]]
    .assert_eq(&home(&fixture));
    fixture.mark_all("feature");
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        ○   empty
        ◌   infra
        ╰─○   feature

        Workspaces
        ○   main
    "#]]
    .assert_eq(&home(&fixture));
    fixture.commit("feature", &[("feature.txt", "feature 2\n")]);
    expect![[r#"
        Review
        ◌   infra
        ╰─○   feature

        Owned
        ○   empty
        ◌   infra
        ╰─○   feature

        Workspaces
        ○   main
    "#]]
    .assert_eq(&home(&fixture));
}

/// Owners review a change only once it is up for review, by owners or by all.
#[test]
fn changes_await_review_only_once_up_for_it() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("draft", "main", &alice());
    fixture.commit("draft", &[("draft.txt", "draft\n")]);
    fixture.create("everyone", "main", &alice());
    fixture.commit("everyone", &[("everyone.txt", "everyone\n")]);
    fixture.cabaret.set_reviewing(&id("everyone"), Reviewing::All, &BTreeSet::new()).unwrap();
    expect![[r#"
        Review
        ○   everyone

        Owned
        ○   draft
        ○   everyone

        Workspaces
        ○   main
    "#]]
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
    fixture.request_review("feature");
    fixture.mark_all("feature");
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture.cabaret.rebase(&id("feature"), None, &BTreeSet::new()).unwrap();
    expect![[r#"
        Review
        nothing awaiting review by alice@example.com

        Owned
        ○   feature

        Workspaces
        ○   main
    "#]]
    .assert_eq(&home(&fixture));
    fixture.commit("main", &[("greeting.txt", "hey\n")]);
    fixture.cabaret.rebase(&id("feature"), None, &BTreeSet::new()).unwrap();
    expect![[r#"
        Review
        ○   feature

        Owned
        ○   feature

        Workspaces
        ○   main
    "#]]
    .assert_eq(&home(&fixture));
}
