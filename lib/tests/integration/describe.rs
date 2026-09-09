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
    fixture.cabaret.set_description(&id("child"), Some("What it does.\n\nAnd why.\n".into())).unwrap();
    expect![[r#"
        message "edit description\n"
        description.md "What it does.\n\nAnd why.\n"
        log.jsonl "{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"add-owner\",\"owner\":\"alice@example.com\"}\n{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"add-parent\",\"parent\":\"main\"}\n"
    "#]]
    .assert_eq(&fixture.metadata("child"));
    assert_eq!(fixture.snapshot("child").description.as_deref(), Some("What it does.\n\nAnd why.\n"));
}

#[test]
fn clearing_leaves_the_file_empty() {
    let fixture = child();
    fixture.cabaret.set_description(&id("child"), Some("Described.".into())).unwrap();
    fixture.cabaret.set_description(&id("child"), None).unwrap();
    expect![[r#"
        message "edit description\n"
        description.md ""
        log.jsonl "{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"add-owner\",\"owner\":\"alice@example.com\"}\n{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"add-parent\",\"parent\":\"main\"}\n"
    "#]]
    .assert_eq(&fixture.metadata("child"));
    assert_eq!(fixture.snapshot("child").description, None);
}

#[test]
fn a_log_edit_carries_the_description_along() {
    let fixture = child();
    fixture.cabaret.set_description(&id("child"), Some("Described.".into())).unwrap();
    fixture.cabaret.set_title(&id("child"), Some("Titled".into())).unwrap();
    expect![[r#"
        message "{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"set-title\",\"title\":\"Titled\"}\n"
        description.md "Described."
        log.jsonl "{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"add-owner\",\"owner\":\"alice@example.com\"}\n{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"add-parent\",\"parent\":\"main\"}\n{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"set-title\",\"title\":\"Titled\"}\n"
    "#]]
    .assert_eq(&fixture.metadata("child"));
}

#[test]
fn setting_the_same_description_is_refused() {
    let fixture = child();
    fixture.cabaret.set_description(&id("child"), Some("Described.".into())).unwrap();
    let error = fixture.cabaret.set_description(&id("child"), Some("Described.".into())).unwrap_err();
    expect!["child already had this description"].assert_eq(&format!("{error:?}"));
    let error = fixture.cabaret.set_description(&id("main"), None).unwrap_err();
    expect!["main already had this description"].assert_eq(&format!("{error:?}"));
}

#[test]
fn an_empty_description_clears() {
    let fixture = child();
    fixture.cabaret.set_description(&id("child"), Some("Described.".into())).unwrap();
    fixture.cabaret.set_description(&id("child"), Some(String::new())).unwrap();
    assert_eq!(fixture.snapshot("child").description, None);
    let error = fixture.cabaret.set_description(&id("child"), Some(String::new())).unwrap_err();
    expect!["child already had this description"].assert_eq(&format!("{error:?}"));
}

/// Older logs set the description in an entry; that reads until the file exists, and the next
/// write, whatever it is, moves the description into the file.
#[test]
fn a_description_logged_before_the_file_existed_still_reads() {
    let fixture = child();
    fixture.write_metadata(
        "child",
        &[(
            "log.jsonl",
            concat!(
                "{\"timestamp\":1,\"user\":\"alice@example.com\",\"action\":\"add-owner\",\"owner\":\"alice@example.com\"}\n",
                "{\"timestamp\":2,\"user\":\"alice@example.com\",\"action\":\"set-description\",\"description\":\"Logged.\"}\n",
            ),
        )],
    );
    assert_eq!(fixture.snapshot("child").description.as_deref(), Some("Logged."));
    fixture.cabaret.set_title(&id("child"), Some("Titled".into())).unwrap();
    expect![[r#"
        message "{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"set-title\",\"title\":\"Titled\"}\n"
        description.md "Logged."
        log.jsonl "{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"add-owner\",\"owner\":\"alice@example.com\"}\n{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"set-description\",\"description\":\"Logged.\"}\n{\"timestamp\":<time>,\"user\":\"alice@example.com\",\"action\":\"set-title\",\"title\":\"Titled\"}\n"
    "#]]
    .assert_eq(&fixture.metadata("child"));
    fixture.cabaret.set_description(&id("child"), None).unwrap();
    assert_eq!(fixture.snapshot("child").description, None);
}
