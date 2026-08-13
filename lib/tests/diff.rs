mod fixture;

use cabaret_lib::{Base, ChangedFile, Diff, FileVersion, Revision};
use fixture::Fixture;
use gix::{ObjectId, objs::tree::EntryKind};

fn diff(fixture: &Fixture, change: &str) -> Diff { fixture.cabaret.diff(&change.parse().unwrap()).unwrap() }

fn blob(fixture: &Fixture, content: &str) -> FileVersion {
    let id: ObjectId = fixture.repo().write_blob(content.as_bytes()).unwrap().detach();
    FileVersion { id, mode: EntryKind::Blob.into() }
}

#[test]
fn lists_added_modified_and_deleted_files() {
    let fixture = Fixture::new();
    let root =
        fixture.commit("refs/heads/main", &[("keep.txt", "same\n"), ("gone.txt", "bye\n"), ("edit.txt", "one\n")], &[]);
    fixture.commit("refs/heads/child", &[("keep.txt", "same\n"), ("edit.txt", "two\n"), ("new.txt", "hi\n")], &[root]);
    fixture.set_parents("child", &["main"]);

    assert_eq!(
        diff(&fixture, "child"),
        Diff {
            base: Base::Real(Revision(root)),
            files: vec![
                ChangedFile::Modified {
                    path: "edit.txt".into(),
                    base: blob(&fixture, "one\n"),
                    tip: blob(&fixture, "two\n"),
                },
                ChangedFile::Deleted { path: "gone.txt".into(), base: blob(&fixture, "bye\n") },
                ChangedFile::Added { path: "new.txt".into(), tip: blob(&fixture, "hi\n") },
            ],
        }
    );
}

#[test]
fn detects_moved_files() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("old.txt", "moving content\n")], &[]);
    fixture.commit("refs/heads/child", &[("nested/new.txt", "moving content\n")], &[root]);
    fixture.set_parents("child", &["main"]);

    assert_eq!(
        diff(&fixture, "child"),
        Diff {
            base: Base::Real(Revision(root)),
            files: vec![ChangedFile::Moved {
                from: "old.txt".into(),
                path: "nested/new.txt".into(),
                copied: false,
                base: blob(&fixture, "moving content\n"),
                tip: blob(&fixture, "moving content\n"),
            }],
        }
    );
}

#[test]
fn a_change_with_no_parents_diffs_from_the_empty_tree() {
    let fixture = Fixture::new();
    fixture.commit("refs/heads/main", &[("file.txt", "main\n")], &[]);
    fixture.set_parents("main", &[]);

    assert_eq!(
        diff(&fixture, "main"),
        Diff {
            base: Base::Empty,
            files: vec![ChangedFile::Added { path: "file.txt".into(), tip: blob(&fixture, "main\n") }],
        }
    );
}

#[test]
fn a_synthetic_base_diff_shows_the_conflict_resolution() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("greeting.txt", "hello\n")], &[]);
    let pa = fixture.commit("refs/heads/pa", &[("greeting.txt", "pa\n")], &[root]);
    let pb = fixture.commit("refs/heads/pb", &[("greeting.txt", "pb\n")], &[root]);
    fixture.commit("refs/heads/child", &[("greeting.txt", "resolved\n")], &[pa, pb]);
    fixture.set_parents("child", &["pa", "pb"]);

    let diff = diff(&fixture, "child");

    let Base::Synthetic { conflicts, .. } = &diff.base else { panic!("expected a synthetic base") };
    assert_eq!(conflicts, &["greeting.txt".to_string()]);
    let markers = "<<<<<<< pa\npa\n||||||| base\nhello\n=======\npb\n>>>>>>> pb\n";
    assert_eq!(
        diff.files,
        vec![ChangedFile::Modified {
            path: "greeting.txt".into(),
            base: blob(&fixture, markers),
            tip: blob(&fixture, "resolved\n"),
        }]
    );
}
