mod fixture;

use cabaret_lib::Diff;
use fixture::Fixture;

fn rendered(fixture: &Fixture, change: &str) -> String {
    let diff = diff(fixture, change);
    fixture.cabaret.render_diff(&diff, false).unwrap()
}

fn diff(fixture: &Fixture, change: &str) -> Diff { fixture.cabaret.diff(&change.parse().unwrap()).unwrap() }

#[test]
fn renders_hunks_for_added_modified_and_deleted_files() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("edit.txt", "a\nb\nc\n"), ("gone.txt", "bye\n")], &[]);
    fixture.commit("refs/heads/child", &[("edit.txt", "a\nB\nc\n"), ("new.txt", "hi\nthere\n")], &[root]);
    fixture.set_parents("child", &["main"]);

    assert_eq!(
        rendered(&fixture, "child"),
        "edit.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\
         \ngone.txt (deleted)\n@@ -1 +1,0 @@\n-bye\n\
         \nnew.txt (added)\n@@ -1,0 +1,2 @@\n+hi\n+there\n"
    );
}

#[test]
fn renders_a_move_as_its_paths() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("old.txt", "moving content\n")], &[]);
    fixture.commit("refs/heads/child", &[("nested/new.txt", "moving content\n")], &[root]);
    fixture.set_parents("child", &["main"]);

    assert_eq!(rendered(&fixture, "child"), "old.txt => nested/new.txt\n");
}

#[test]
fn renders_a_synthetic_base_resolution_with_a_conflict_note() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("greeting.txt", "hello\n")], &[]);
    let pa = fixture.commit("refs/heads/pa", &[("greeting.txt", "pa\n")], &[root]);
    let pb = fixture.commit("refs/heads/pb", &[("greeting.txt", "pb\n")], &[root]);
    fixture.commit("refs/heads/child", &[("greeting.txt", "resolved\n")], &[pa, pb]);
    fixture.set_parents("child", &["pa", "pb"]);

    assert_eq!(
        rendered(&fixture, "child"),
        "synthetic base conflicts: greeting.txt\n\
         \ngreeting.txt\n@@ -1,7 +1 @@\n\
         -<<<<<<< pa\n-pa\n-||||||| base\n-hello\n-=======\n-pb\n->>>>>>> pb\n\
         +resolved\n"
    );
}

#[test]
fn renders_binary_files_without_hunks() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("blob.bin", "a\0b")], &[]);
    fixture.commit("refs/heads/child", &[("blob.bin", "a\0c")], &[root]);
    fixture.set_parents("child", &["main"]);

    assert_eq!(rendered(&fixture, "child"), "blob.bin\nbinary files differ\n");
}

#[test]
fn colors_the_pieces_when_enabled() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("edit.txt", "one\n")], &[]);
    fixture.commit("refs/heads/child", &[("edit.txt", "two\n")], &[root]);
    fixture.set_parents("child", &["main"]);

    let diff = diff(&fixture, "child");
    assert_eq!(
        fixture.cabaret.render_diff(&diff, true).unwrap(),
        "\x1b[1medit.txt\x1b[0m\n\x1b[36m@@ -1 +1 @@\x1b[0m\n\x1b[31m-one\x1b[0m\n\x1b[32m+two\x1b[0m\n"
    );
}

#[test]
fn selects_files_by_pathspec() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("src/lib.rs", "a\n"), ("docs/guide.md", "b\n")], &[]);
    fixture.commit("refs/heads/child", &[("src/lib.rs", "A\n"), ("docs/guide.md", "B\n")], &[root]);
    fixture.set_parents("child", &["main"]);

    let diff = diff(&fixture, "child");
    let selected = fixture.cabaret.select(diff.files, vec!["src/".parse().unwrap()]).unwrap();

    let paths: Vec<&str> = selected.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, ["src/lib.rs"]);
}
