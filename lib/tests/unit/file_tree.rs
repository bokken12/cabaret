use cabaret_lib::{ChangedFile, FileTree, Page, RepoPath};
use expect_test::expect;

fn render(paths: &[&str]) -> Page {
    let files: Vec<_> = paths.iter().map(|path| ChangedFile::Modified { path: path.parse().unwrap() }).collect();
    FileTree::new(&files).render()
}

#[test]
fn empty_and_single_file_trees_need_no_folds() {
    let empty = render(&[]);
    assert_eq!(empty, Page::default());
    let single = render(&["src/parser/tokens.rs"]);
    expect![["○ src/parser/tokens.rs\n"]].assert_eq(&single.to_string());
    assert!(single.folds.is_empty());
}

#[test]
fn nested_branches_keep_continuations_and_sorted_folds() {
    let page =
        render(&["z.txt", "src/z.rs", "src/a/二.rs", "src/a/一.rs", "src/a/deep/file.rs", "src/a/deep/other.rs"]);
    expect![[r"
        ◌ src/
        ├─◌ a/
        │ ├─◌ deep/
        │ │ ├─○ file.rs
        │ │ ╰─○ other.rs
        │ ├─○ 一.rs
        │ ╰─○ 二.rs
        ╰─○ z.rs
        ○ z.txt
    "]]
    .assert_eq(&page.to_string());
    expect![["[Fold { start: 0, end: 7 }, Fold { start: 1, end: 6 }, Fold { start: 2, end: 4 }]"]]
        .assert_eq(&format!("{:?}", page.folds));
}

#[test]
fn deleted_file_can_be_replaced_by_a_directory() {
    let files = [ChangedFile::Deleted { path: path("item") }, ChangedFile::Added { path: path("item/child") }];
    let page = FileTree::new(&files).render();
    expect![[r"
        ○ [Deleted|item]
        ◌ [Label|item/]
        ╰─○ [Added|child]
    "]]
    .assert_eq(&super::page::markup(&page));
    expect![["[Fold { start: 1, end: 2 }]"]].assert_eq(&format!("{:?}", page.folds));
}

fn path(path: &str) -> RepoPath { path.parse().unwrap() }

#[test]
fn mixed_changes_show_status_and_sources_under_the_destination() {
    let files = [
        ChangedFile::Renamed { from: path("old/tokens.rs"), path: path("src/parser/tokens.rs") },
        ChangedFile::Copied { from: path("shared/helper.rs"), path: path("src/parser/helper.rs") },
        ChangedFile::Renamed { from: path("src/parser/old.rs"), path: path("src/parser/new.rs") },
        ChangedFile::Added { path: path("src/parser/added.rs") },
        ChangedFile::Deleted { path: path("src/parser/deleted.rs") },
        ChangedFile::Modified { path: path("src/parser/modified.rs") },
    ];
    let page = FileTree::new(&files).render();
    expect![[r"
        ◌ [Label|src/parser/]
        ├─○ [Added|added.rs]
        ├─○ [Deleted|deleted.rs]
        ├─○ [Copied|helper.rs][Muted| ← copied from shared/helper.rs]
        ├─○ [Modified|modified.rs]
        ├─○ [Renamed|new.rs][Muted| ← moved from old.rs]
        ╰─○ [Renamed|tokens.rs][Muted| ← moved from old/tokens.rs]
    "]]
    .assert_eq(&super::page::markup(&page));
    assert!(page.lines.iter().all(|line| line.target.is_none()));
}
