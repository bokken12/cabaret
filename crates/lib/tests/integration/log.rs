//! The log's commit graph: how writes that did and did not see each other fold, and the
//! revisions a log commit keeps as parents.

use std::collections::BTreeSet;

use cabaret_lib::{RevisionId, log::LogAction, safeguard::Allow};
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id, short};

/// `child` on `main`, its log holding just its creation.
fn child() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("child", "main", &alice());
    fixture
}

fn title(title: &str) -> LogAction { LogAction::SetTitle { title: Some(title.into()) } }

fn mark(revision: RevisionId) -> LogAction {
    LogAction::Mark { reviewer: alice(), file: "greeting.txt".parse().unwrap(), revision }
}

#[test]
fn writes_that_did_not_see_each_other_fold_in_time_order() {
    let fixture = child();
    let created = fixture.log_head("child");
    let earlier = fixture.log_commit(&[created], 10, &[title("earlier")]);
    let later = fixture.log_commit(&[created], 20, &[title("later")]);
    let titles: Vec<_> = [[earlier, later], [later, earlier]]
        .into_iter()
        .map(|parents| {
            fixture.move_log("child", fixture.log_commit(&parents, 30, &[]));
            fixture.snapshot("child").title
        })
        .collect();
    expect![[r#"[Some("later"), Some("later")]"#]].assert_eq(&format!("{titles:?}"));
}

#[test]
fn a_write_folds_after_what_it_saw_whatever_its_clock() {
    let fixture = child();
    let created = fixture.log_head("child");
    let seen = fixture.log_commit(&[created], 20, &[title("seen")]);
    let behind = fixture.log_commit(&[seen], 10, &[title("written on a clock running behind")]);
    let concurrent = fixture.log_commit(&[created], 15, &[title("concurrent")]);
    fixture.move_log("child", fixture.log_commit(&[behind, concurrent], 30, &[]));
    expect![[r#"Some("written on a clock running behind")"#]]
        .assert_eq(&format!("{:?}", fixture.snapshot("child").title));
}

#[test]
fn marking_takes_the_marked_revision_as_a_parent() {
    let fixture = child();
    let before = fixture.log_head("child");
    let tip = fixture.commit("child", &[("greeting.txt", "hi\n")]);
    fixture.cabaret.mark(&id("child"), &["greeting.txt".parse().unwrap()], None).unwrap();
    let parents: Vec<_> = fixture
        .parents(fixture.log_head("child"))
        .into_iter()
        .map(|parent| match parent {
            parent if parent == before => "log".into(),
            parent if parent == tip => "tip".into(),
            parent => short(parent),
        })
        .collect();
    expect!["log tip"].assert_eq(&parents.join(" "));
    assert_eq!(fixture.snapshot("child").review[&alice()].values().collect::<Vec<_>>(), [&tip]);
}

#[test]
fn a_log_commit_must_take_what_it_refers_to_as_a_parent() {
    let fixture = child();
    let created = fixture.log_head("child");
    let tip = fixture.commit("child", &[("greeting.txt", "hi\n")]);
    let orphaned = fixture.log_commit(&[created], 10, &[mark(tip)]);
    fixture.move_log("child", orphaned);
    let error = fixture.cabaret.snapshot(&id("child")).unwrap_err();
    expect!["log commit ORPHANED refers to TIP without taking it as a parent"]
        .assert_eq(&format!("{error:?}").replace(&orphaned.to_string(), "ORPHANED").replace(&tip.to_string(), "TIP"));
}

#[test]
fn edits_already_in_effect_write_nothing() {
    let fixture = child();
    fixture.root("other", &[]);
    let child = id("child");
    let greeting = ["greeting.txt".parse().unwrap()];
    let allow = Allow::default();
    fixture.cabaret.set_title(&child, Some("Titled".into())).unwrap();
    fixture.cabaret.set_description(&child, Some("Described.".into())).unwrap();
    fixture.cabaret.mark(&child, &greeting, None).unwrap();
    let before = fixture.log_head("child");
    fixture.cabaret.set_title(&child, Some("Titled".into())).unwrap();
    fixture.cabaret.set_description(&child, Some("Described.".into())).unwrap();
    fixture.cabaret.mark(&child, &greeting, None).unwrap();
    fixture.cabaret.add_owner(&child, &alice()).unwrap();
    fixture.cabaret.remove_owner(&child, &bob(), &allow).unwrap();
    fixture.cabaret.set_owners(&child, &BTreeSet::from([alice()]), &allow).unwrap();
    fixture.cabaret.add_parent(&child, &id("main"), &allow).unwrap();
    fixture.cabaret.remove_parent(&child, &id("other"), &allow).unwrap();
    fixture.cabaret.unarchive(&child, &allow).unwrap();
    fixture.cabaret.set_permanent(&child, false, &allow).unwrap();
    assert_eq!(fixture.log_head("child"), before);
    fixture.cabaret.archive(&child, &allow).unwrap();
    let archived = fixture.log_head("child");
    fixture.cabaret.archive(&child, &allow).unwrap();
    assert_eq!(fixture.log_head("child"), archived);
}
