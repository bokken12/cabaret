//! Describing: a change's description is a file beside its log, so git merges edits to it
//! rather than the log's last writer winning.

use expect_test::expect;

use super::fixture::{Fixture, alice, id};

fn child() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture
}

#[test]
fn description_is_a_file_beside_the_log() {
    let fixture = child();
    fixture.cabaret.set_description(&id("child"), "What it does.\n\nAnd why.\n".into()).unwrap();
    expect![[r#"
        message "edit description\n"
        actions.jsonl ""
        description.md "What it does.\n\nAnd why.\n"
    "#]]
    .assert_eq(&fixture.metadata("child"));
    assert_eq!(fixture.snapshot("child").description.as_deref(), Some("What it does.\n\nAnd why.\n"));
}

#[test]
fn clearing_leaves_the_file_empty() {
    let fixture = child();
    fixture.cabaret.set_description(&id("child"), "Described.".into()).unwrap();
    fixture.cabaret.set_description(&id("child"), String::new()).unwrap();
    expect![[r#"
        message "edit description\n"
        actions.jsonl ""
        description.md ""
    "#]]
    .assert_eq(&fixture.metadata("child"));
    assert_eq!(fixture.snapshot("child").description, None);
}

#[test]
fn a_log_edit_carries_the_description_along() {
    let fixture = child();
    fixture.cabaret.set_description(&id("child"), "Described.".into()).unwrap();
    fixture.cabaret.set_title(&id("child"), Some("Titled".into())).unwrap();
    expect![[r#"
        message "{\"action\":\"set-title\",\"title\":\"Titled\"}\n"
        actions.jsonl "{\"action\":\"set-title\",\"title\":\"Titled\"}\n"
        description.md "Described."
    "#]]
    .assert_eq(&fixture.metadata("child"));
}

#[test]
fn a_blank_description_clears() {
    let fixture = child();
    fixture.cabaret.set_description(&id("child"), "Described.".into()).unwrap();
    fixture.cabaret.set_description(&id("child"), " \n".into()).unwrap();
    assert_eq!(fixture.snapshot("child").description, None);
}
