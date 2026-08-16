mod fixture;

use cabaret_lib::NextStep;
use fixture::{Fixture, diverged};

fn step(fixture: &Fixture, change: &str) -> NextStep { fixture.cabaret.next_step(&change.parse().unwrap()).unwrap() }

#[test]
fn a_fresh_change_needs_code() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "main\n")], &[]);
    fixture.branch("child", root);
    fixture.set_parents("child", &["main"]);

    assert_eq!(step(&fixture, "child"), NextStep::AddCode);
}

#[test]
fn a_change_with_code_atop_a_fresh_parent_lands() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "main\n")], &[]);
    fixture.commit("refs/heads/child", &[("file.txt", "main\n"), ("child.txt", "child\n")], &[root]);
    fixture.set_parents("child", &["main"]);

    assert_eq!(step(&fixture, "child"), NextStep::Land);
}

#[test]
fn a_parent_tip_off_the_changes_history_calls_for_rebase() {
    let fixture = diverged(
        &[("file.txt", "original\n")],
        &[("file.txt", "original\n"), ("child.txt", "child\n")],
        &[("file.txt", "original\n"), ("main.txt", "main\n")],
    );
    fixture.set_parents("child", &["main"]);

    assert_eq!(step(&fixture, "child"), NextStep::Rebase);
}

#[test]
fn committed_conflict_markers_call_for_fixing() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("file.txt", "main\n")]);
    fixture.set_parents("child", &["main"]);

    let conflicts = fixture.merge("main").unwrap().expect("expected a merge");

    assert_eq!(conflicts, vec!["file.txt".to_string()]);
    assert_eq!(step(&fixture, "child"), NextStep::FixConflicts);
}

#[test]
fn conflict_markers_outrank_a_stale_parent() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("file.txt", "main\n")]);
    fixture.set_parents("child", &["main"]);
    fixture.merge("main").unwrap().expect("expected a merge");
    let (merged_main, _) = fixture.tip("main");

    fixture.commit("refs/heads/main", &[("file.txt", "main\n"), ("later.txt", "later\n")], &[merged_main]);

    assert_eq!(step(&fixture, "child"), NextStep::FixConflicts);
}

#[test]
fn an_up_to_date_multi_parent_change_lands_its_parents_first() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("a.txt", "a\n"), ("b.txt", "b\n")], &[]);
    let pa = fixture.commit("refs/heads/pa", &[("a.txt", "a edited\n"), ("b.txt", "b\n")], &[root]);
    let pb = fixture.commit("refs/heads/pb", &[("a.txt", "a\n"), ("b.txt", "b edited\n")], &[root]);
    fixture.commit(
        "refs/heads/child",
        &[("a.txt", "a edited\n"), ("b.txt", "b edited\n"), ("child.txt", "child\n")],
        &[pa, pb],
    );
    fixture.set_parents("child", &["pa", "pb"]);

    assert_eq!(step(&fixture, "child"), NextStep::LandParents);
}

#[test]
fn a_conflicted_integration_reads_its_markers_through_its_diff() {
    // The tip's markers label the change where the synthetic base's label its first parent,
    // so even a fresh integration's markers show in its diff and read as its own to fix.
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("greeting.txt", "hello\n")], &[]);
    let pa = fixture.commit("refs/heads/pa", &[("greeting.txt", "pa\n")], &[root]);
    fixture.commit("refs/heads/pb", &[("greeting.txt", "pb\n")], &[root]);
    fixture.branch("child", pa);
    fixture.set_parents("child", &["pa", "pb"]);
    fixture.checkout("child", &[("greeting.txt", "pa\n")]);

    let conflicts = fixture.merge("pb").unwrap().expect("expected a merge");

    assert_eq!(conflicts, vec!["greeting.txt".to_string()]);
    assert_eq!(step(&fixture, "child"), NextStep::FixConflicts);
}

#[test]
fn a_conflicted_parent_outranks_the_rebase_it_would_taint() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "original\n")], &[]);
    let parent = fixture.commit("refs/heads/parent", &[("file.txt", "parent\n")], &[root]);
    fixture.commit("refs/heads/main", &[("file.txt", "main\n")], &[root]);
    fixture.set_parents("parent", &["main"]);
    fixture.checkout("parent", &[("file.txt", "parent\n")]);
    let merge = fixture.prepare("parent", "main").unwrap().expect("expected a merge");
    fixture.cabaret.commit_merge(merge, "rebase onto main".into()).unwrap();

    fixture.commit("refs/heads/child", &[("child.txt", "child\n")], &[parent]);
    fixture.set_parents("child", &["parent"]);

    assert_eq!(step(&fixture, "parent"), NextStep::FixConflicts);
    assert_eq!(step(&fixture, "child"), NextStep::FixConflictsInParent);
}
