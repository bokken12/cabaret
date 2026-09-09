use cabaret_lib::{FileTree, Line, Page, RepoPath, Segment, Tag};
use expect_test::expect;

fn render(paths: &[&str]) -> Page {
    let paths: Vec<RepoPath> = paths.iter().map(|path| path.parse().unwrap()).collect();
    let mut tree = FileTree::default();
    for path in &paths {
        tree.insert(path, path);
    }
    tree.render(|_, name| Line::plain(name))
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
fn rendering_preserves_values_and_multiple_entries_at_the_same_path() {
    let path: RepoPath = "item".parse().unwrap();
    let child: RepoPath = "item/child".parse().unwrap();
    let mut tree = FileTree::default();
    tree.insert(&path, &1);
    tree.insert(&path, &2);
    tree.insert(&child, &3);
    let page =
        tree.render(|value, name| Line::default().push(Segment::tagged(format!("{name}: {value}"), Tag::Modified)));
    expect![[r"
        ○ item: 1
        ○ item: 2
        ◌ item/
        ╰─○ child: 3
    "]]
    .assert_eq(&page.to_string());
    expect![["[Fold { start: 2, end: 3 }]"]].assert_eq(&format!("{:?}", page.folds));
    for index in [0, 1, 3] {
        assert_eq!(page.lines[index].segments[1].tag, Some(Tag::Modified));
    }
}
