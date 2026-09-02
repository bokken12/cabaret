//! The home graph: what `home_graph` includes for a viewer and how the page draws it.

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
        ◌   infra
        ╰─○   feature  My feature
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
        ○   top
    "]]
    .assert_eq(&home(&fixture));
}

#[test]
fn nothing_owned_says_so() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("theirs", "main", &bob());
    expect![[r"
        no open changes owned by alice@example.com
    "]]
    .assert_eq(&home(&fixture));
}
