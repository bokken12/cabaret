mod fixture;

use cabaret_lib::{Base, Revision};
use fixture::{Fixture, diverged};

fn base(fixture: &Fixture, change: &str) -> cabaret_lib::Result<Base> { fixture.cabaret.base(&change.parse().unwrap()) }

fn synthetic(base: Base) -> (Revision, Vec<String>) {
    match base {
        Base::Synthetic { revision, conflicts } => (revision, conflicts),
        other => panic!("expected a synthetic base, got {other:?}"),
    }
}

fn raw_commit(fixture: &Fixture, revision: Revision) -> String {
    String::from_utf8(fixture.repo().find_object(revision).unwrap().data.clone()).unwrap()
}

#[test]
fn a_change_with_no_parents_has_an_empty_base() {
    let fixture = Fixture::new();
    fixture.commit("refs/heads/main", &[("file.txt", "main\n")], &[]);
    fixture.set_parents("main", &[]);

    assert_eq!(base(&fixture, "main").unwrap(), Base::Empty);
}

#[test]
fn a_single_parent_base_is_the_last_incorporated_revision() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "original\n")], &[]);
    fixture.commit("refs/heads/child", &[("file.txt", "child\n")], &[root]);
    fixture.commit("refs/heads/main", &[("file.txt", "original\n"), ("main.txt", "main\n")], &[root]);
    fixture.set_parents("child", &["main"]);

    assert_eq!(base(&fixture, "child").unwrap(), Base::Real(root));
}

#[test]
fn merging_the_parent_moves_the_base_to_the_merged_revision() {
    let fixture = diverged(
        &[("file.txt", "original\n")],
        &[("file.txt", "child\n")],
        &[("file.txt", "original\n"), ("main.txt", "main\n")],
    );
    fixture.set_parents("child", &["main"]);
    let (merged_main, _) = fixture.tip("main");

    fixture.merge("main").unwrap().expect("expected a merge");
    fixture.commit("refs/heads/main", &[("file.txt", "original\n"), ("main.txt", "later\n")], &[merged_main]);

    assert_eq!(base(&fixture, "child").unwrap(), Base::Real(merged_main));
}

#[test]
fn a_multi_parent_base_merges_the_incorporated_revisions() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("a.txt", "a\n"), ("b.txt", "b\n")], &[]);
    let pa = fixture.commit("refs/heads/pa", &[("a.txt", "a edited\n"), ("b.txt", "b\n")], &[root]);
    let pb = fixture.commit("refs/heads/pb", &[("a.txt", "a\n"), ("b.txt", "b edited\n")], &[root]);
    fixture.commit("refs/heads/child", &[("a.txt", "a edited\n"), ("b.txt", "b edited\n")], &[pa, pb]);
    fixture.set_parents("child", &["pa", "pb"]);

    let (revision, conflicts) = synthetic(base(&fixture, "child").unwrap());

    assert_eq!(conflicts, Vec::<String>::new());
    assert_eq!(fixture.revision_file(revision, "a.txt"), "a edited\n");
    assert_eq!(fixture.revision_file(revision, "b.txt"), "b edited\n");
    let tree = fixture.repo().find_commit(revision).unwrap().tree_id().unwrap();
    assert_eq!(
        raw_commit(&fixture, revision),
        format!(
            "tree {tree}\nparent {pa}\nparent {pb}\n\
             author cabaret <> 0 +0000\ncommitter cabaret <> 0 +0000\n\nsynthetic base\n"
        )
    );
}

#[test]
fn conflicting_parents_leave_markers_in_the_base() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("greeting.txt", "hello\n")], &[]);
    let pa = fixture.commit("refs/heads/pa", &[("greeting.txt", "pa\n")], &[root]);
    let pb = fixture.commit("refs/heads/pb", &[("greeting.txt", "pb\n")], &[root]);
    fixture.commit("refs/heads/child", &[("greeting.txt", "resolved\n")], &[pa, pb]);
    fixture.set_parents("child", &["pa", "pb"]);

    let (revision, conflicts) = synthetic(base(&fixture, "child").unwrap());

    assert_eq!(conflicts, vec!["greeting.txt".to_string()]);
    assert_eq!(
        fixture.revision_file(revision, "greeting.txt"),
        "<<<<<<< pa\npa\n||||||| base\nhello\n=======\npb\n>>>>>>> pb\n"
    );
}

#[test]
fn a_third_conflicting_parent_nests_with_longer_markers() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("greeting.txt", "hello\n")], &[]);
    let pa = fixture.commit("refs/heads/pa", &[("greeting.txt", "pa\n")], &[root]);
    let pb = fixture.commit("refs/heads/pb", &[("greeting.txt", "pb\n")], &[root]);
    let pc = fixture.commit("refs/heads/pc", &[("greeting.txt", "pc\n")], &[root]);
    fixture.commit("refs/heads/child", &[("greeting.txt", "resolved\n")], &[pa, pb, pc]);
    fixture.set_parents("child", &["pa", "pb", "pc"]);

    let (revision, conflicts) = synthetic(base(&fixture, "child").unwrap());

    assert_eq!(conflicts, vec!["greeting.txt".to_string()]);
    // Zealous diff3 minimizes the outer region, so the inner conflict's tail dangles after the
    // outer end marker; the escalated marker length keeps the nesting unambiguous.
    assert_eq!(
        fixture.revision_file(revision, "greeting.txt"),
        "<<<<<<<<<<< pa+pb\n<<<<<<< pa\npa\n||||||| base\nhello\n||||||||||| base\nhello\n===========\npc\n>>>>>>>>>>> pc\n=======\npb\n>>>>>>> pb\n"
    );
    let parents: Vec<Revision> =
        fixture.repo().find_commit(revision).unwrap().parent_ids().map(|id| Revision(id.detach())).collect();
    assert_eq!(parents, vec![pa, pb, pc]);
}

#[test]
fn parents_incorporated_at_the_same_revision_collapse_to_one() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "original\n")], &[]);
    fixture.branch("pa", root);
    fixture.branch("pb", root);
    fixture.commit("refs/heads/child", &[("file.txt", "child\n")], &[root]);
    fixture.set_parents("child", &["pa", "pb"]);

    assert_eq!(base(&fixture, "child").unwrap(), Base::Real(root));
}

#[test]
fn an_incorporated_revision_containing_another_wins() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "original\n")], &[]);
    let feature = fixture.commit("refs/heads/feature", &[("file.txt", "feature\n")], &[root]);
    fixture.commit("refs/heads/child", &[("file.txt", "child\n")], &[feature]);
    fixture.set_parents("child", &["feature", "main"]);

    assert_eq!(base(&fixture, "child").unwrap(), Base::Real(feature));
}

#[test]
fn an_ambiguous_base_is_an_error() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "original\n")], &[]);
    let a = fixture.commit("refs/heads/a", &[("a.txt", "a\n")], &[root]);
    let b = fixture.commit("refs/heads/b", &[("b.txt", "b\n")], &[root]);
    fixture.commit("refs/heads/child", &[("a.txt", "a\n"), ("b.txt", "b\n")], &[a, b]);
    let crossed = fixture.commit("refs/heads/crossed", &[("a.txt", "a\n"), ("b.txt", "b\n")], &[b, a]);
    fixture.branch("main", crossed);
    fixture.set_parents("child", &["main"]);

    let error = base(&fixture, "child").unwrap_err();
    assert_eq!(format!("{error:?}"), "child has an ambiguous base with main; rebase onto it to resolve");
}

#[test]
fn a_parent_sharing_no_history_is_an_error() {
    let fixture = Fixture::new();
    fixture.commit("refs/heads/main", &[("file.txt", "main\n")], &[]);
    fixture.commit("refs/heads/child", &[("file.txt", "child\n")], &[]);
    fixture.set_parents("child", &["main"]);

    let error = base(&fixture, "child").unwrap_err();
    assert_eq!(format!("{error:?}"), "child shares no history with its parent main");
}
