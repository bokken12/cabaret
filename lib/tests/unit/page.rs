use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use cabaret_lib::{
    ChangeId, ChangeSnapshot, ChangedFile, Identity, Page, RevisionId, Segment, Session, SessionId, Status, Target,
    TimestampMs,
};
use expect_test::expect;

fn revision(digit: char) -> RevisionId { RevisionId(String::from(digit).repeat(40).parse().unwrap()) }

fn snapshot(title: Option<&str>, description: Option<&str>, owners: &[&str], parents: &[&str]) -> ChangeSnapshot {
    ChangeSnapshot {
        tip: revision('a'),
        bases: parents.iter().zip('1'..).map(|(_, digit)| revision(digit)).collect(),
        title: title.map(String::from),
        description: description.map(String::from),
        archived: false,
        permanent: false,
        owners: owners.iter().map(|owner| Identity((*owner).into())).collect(),
        parents: parents.iter().map(|parent| parent.parse().unwrap()).collect(),
        declared_parents: BTreeSet::new(),
        review: BTreeMap::new(),
        workspace: None,
    }
}

fn describe(target: &Target) -> String {
    match target {
        Target::Change { change } => format!("change:{change}"),
        Target::Diff { change, file } => format!("diff:{change}:{}", file.paths().last().unwrap()),
        Target::WorkspaceDiff { change, file } => format!("workspace:{change}:{}", file.paths().last().unwrap()),
        Target::ReviewDiff { change, file } => format!("review:{change}:{}", file.paths().last().unwrap()),
        Target::Title { change } => format!("title:{change}"),
        Target::Description { change } => format!("description:{change}"),
        Target::Session { change, session } => format!("session:{change}:{session}"),
    }
}

/// Each segment as `text`, `[Tag|text]`, or `[Tag>target|text]`; a line's own target follows `=>`.
pub fn markup(page: &Page) -> String {
    let mut out = String::new();
    for line in &page.lines {
        for Segment { text, tag, target } in &line.segments {
            match (tag, target) {
                (None, None) => out.push_str(text),
                (tag, target) => {
                    out.push('[');
                    if let Some(tag) = tag {
                        out.push_str(&format!("{tag:?}"));
                    }
                    if let Some(target) = target {
                        out.push_str(&format!(">{}", describe(target)));
                    }
                    out.push_str(&format!("|{text}]"));
                }
            }
        }
        if let Some(target) = &line.target {
            out.push_str(&format!(" => {}", describe(target)));
        }
        out.push('\n');
    }
    out
}

#[test]
fn a_show_page_tags_its_parts_and_targets_its_parents() {
    let change = snapshot(
        Some("Add the parser"),
        Some("A recursive descent parser.\n\nWith tests."),
        &["alice@example.com", "bob@example.com"],
        &["lexer", "tokens"],
    );
    let page = Page::show(&"add-parser".parse::<ChangeId>().unwrap(), &change, Some(Path::new("/repo/add-parser")));
    expect![[r"
        [Heading|add-parser] — [Heading|Add the parser] => title:add-parser

        A recursive descent parser. => description:add-parser
         => description:add-parser
        With tests. => description:add-parser

        [Label|Status:] open
        [Label|Owners:] alice@example.com, bob@example.com
        [Label|Parents:] [ChangeId>change:lexer|lexer], [ChangeId>change:tokens|tokens]
        [Label|Tip:] [Revision|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]
        [Label|Bases:] [Revision|1111111111111111111111111111111111111111], [Revision|2222222222222222222222222222222222222222]
        [Label|Workspace:] /repo/add-parser
    "]]
    .assert_eq(&markup(&page));
    expect![[r"
        add-parser — Add the parser

        A recursive descent parser.

        With tests.

        Status: open
        Owners: alice@example.com, bob@example.com
        Parents: lexer, tokens
        Tip: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Bases: 1111111111111111111111111111111111111111, 2222222222222222222222222222222222222222
        Workspace: /repo/add-parser
    "]]
    .assert_eq(&page.to_string());
}

#[test]
fn a_bare_show_page_marks_what_is_missing() {
    let page = Page::show(&"bare".parse::<ChangeId>().unwrap(), &snapshot(None, None, &[], &[]), None);
    expect![[r"
        [Heading|bare] => title:bare

        [Muted|(no description)] => description:bare

        [Label|Status:] open
        [Label|Owners:] [Muted|(none)]
        [Label|Parents:] [Muted|(none)]
        [Label|Tip:] [Revision|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]
        [Label|Bases:] [Muted|(none)]
        [Label|Workspace:] [Muted|(none)]
    "]]
    .assert_eq(&markup(&page));
}

#[test]
fn show_page_status_is_archived_else_permanent_else_open() {
    let status = |archived: bool, permanent: bool| {
        let change = ChangeSnapshot { archived, permanent, ..snapshot(None, None, &[], &[]) };
        let page = Page::show(&"trunk".parse::<ChangeId>().unwrap(), &change, None);
        page.to_string().lines().nth(4).unwrap().to_owned()
    };
    expect![[r"Status: open"]].assert_eq(&status(false, false));
    expect![[r"Status: permanent"]].assert_eq(&status(false, true));
    expect![[r"Status: archived"]].assert_eq(&status(true, false));
    expect![[r"Status: archived"]].assert_eq(&status(true, true));
}

#[test]
fn a_diff_page_targets_each_file() {
    let path = |path: &str| path.parse().unwrap();
    let files = [
        ChangedFile::Added { path: path("src/new.rs") },
        ChangedFile::Deleted { path: path("src/old.rs") },
        ChangedFile::Modified { path: path("src/lib.rs") },
        ChangedFile::Renamed { from: path("a.rs"), path: path("b.rs") },
        ChangedFile::Copied { from: path("c.rs"), path: path("d.rs") },
    ];
    let page = Page::diff(&"change".parse::<ChangeId>().unwrap(), &files);
    expect![[r"
        [Renamed|b.rs][Muted| ← moved from a.rs] => diff:change:b.rs
        [Copied|d.rs][Muted| ← copied from c.rs] => diff:change:d.rs
        [Label|src/]
          [Modified|lib.rs] => diff:change:src/lib.rs
          [Added|new.rs] => diff:change:src/new.rs
          [Deleted|old.rs] => diff:change:src/old.rs
    "]]
    .assert_eq(&markup(&page));
}

#[test]
fn an_empty_diff_page_says_so() {
    let page = Page::diff(&"empty".parse::<ChangeId>().unwrap(), &[]);
    expect![[r"
        [Muted|no changed files]
    "]]
    .assert_eq(&markup(&page));
}

#[test]
fn a_review_page_targets_each_unreviewed_file() {
    let path = |path: &str| path.parse().unwrap();
    let files = [ChangedFile::Modified { path: path("src/lib.rs") }, ChangedFile::Added { path: path("src/new.rs") }];
    let page = Page::review(&"change".parse::<ChangeId>().unwrap(), &files);
    expect![[r"
        [Label|src/]
          [Modified|lib.rs] => review:change:src/lib.rs
          [Added|new.rs] => review:change:src/new.rs
    "]]
    .assert_eq(&markup(&page));
}

#[test]
fn an_empty_review_page_says_so() {
    let page = Page::review(&"reviewed".parse::<ChangeId>().unwrap(), &[]);
    expect![[r"
        [Muted|no unreviewed files]
    "]]
    .assert_eq(&markup(&page));
}

#[test]
fn a_workspace_page_targets_each_file_on_disk() {
    let path = |path: &str| path.parse().unwrap();
    let files = [
        ChangedFile::Modified { path: path("src/lib.rs") },
        ChangedFile::Renamed { from: path("a.rs"), path: path("b.rs") },
    ];
    let change = "change".parse::<ChangeId>().unwrap();
    expect![[r"
        [Renamed|b.rs][Muted| ← moved from a.rs] => workspace:change:b.rs
        [Modified|src/lib.rs] => workspace:change:src/lib.rs
    "]]
    .assert_eq(&markup(&Page::workspace(&change, &files)));
    expect![[r"
        [Muted|no uncommitted files]
    "]]
    .assert_eq(&markup(&Page::workspace(&change, &[])));
}

#[test]
fn sessions_page_lists_each_session_with_its_age_and_leads_to_it() {
    let now = TimestampMs(100 * 86_400_000);
    let session = |id: &str, title: Option<&str>, seconds_ago: u64, live: Option<Status>| Session {
        id: SessionId(id.to_owned()),
        title: title.map(str::to_owned),
        last_active: TimestampMs(now.0 - seconds_ago * 1000),
        live,
    };
    let change = "parser".parse::<ChangeId>().unwrap();
    let page = Page::sessions(
        &change,
        &[
            session("a1", Some("Fix the parser"), 5, Some(Status::Busy)),
            session("b2", Some("Add tests"), 42 * 60, Some(Status::Idle)),
            session("c3", None, 3 * 3600 + 59 * 60, Some(Status::Unknown)),
            session("d4", Some("Old"), 9 * 86_400, None),
        ],
        now,
    );
    expect![[r"

        [Label|Sessions:]
          Fix the parser[Muted| · just now, busy] => session:parser:a1
          Add tests[Muted| · 42m ago, idle] => session:parser:b2
          c3[Muted| · 3h ago, running] => session:parser:c3
          Old[Muted| · 9d ago] => session:parser:d4
    "]]
    .assert_eq(&markup(&page));
    expect![["[Fold { start: 1, end: 5 }]"]].assert_eq(&format!("{:?}", page.folds));
    expect![[r"

        [Label|Sessions:] [Muted|(none)]
    "]]
    .assert_eq(&markup(&Page::sessions(&change, &[], now)));
}

#[test]
fn file_tree_compacts_paths_and_folds_nested_groups() {
    let files: Vec<_> =
        ["tests/parser/basic.rs", "src/parser/tokens.rs", "README.md", "src/main.rs", "src/parser/expression.rs"]
            .into_iter()
            .map(|path| ChangedFile::Modified { path: path.parse().unwrap() })
            .collect();
    let change = "tree".parse::<ChangeId>().unwrap();
    let page = Page::diff(&change, &files);
    expect![[r"
        [Modified|README.md] => diff:tree:README.md
        [Label|src/]
          [Modified|main.rs] => diff:tree:src/main.rs
          [Label|parser/]
            [Modified|expression.rs] => diff:tree:src/parser/expression.rs
            [Modified|tokens.rs] => diff:tree:src/parser/tokens.rs
        [Modified|tests/parser/basic.rs] => diff:tree:tests/parser/basic.rs
    "]]
    .assert_eq(&markup(&page));
    expect!["[Fold { start: 1, end: 5 }, Fold { start: 3, end: 5 }]"].assert_eq(&format!("{:?}", page.folds));
    // Every view has the same shape; only its file targets differ.
    for other in [Page::review(&change, &files), Page::workspace(&change, &files)] {
        assert_eq!(page.to_string(), other.to_string());
        assert_eq!(page.folds, other.folds);
    }
    let single = Page::review(&change, &files[..1]);
    assert_eq!(single.to_string(), "tests/parser/basic.rs\n");
    assert!(single.folds.is_empty());
}

#[test]
fn moves_and_copies_live_once_at_the_destination_with_their_original_targets() {
    let path = |p: &str| p.parse().unwrap();
    let files = [
        ChangedFile::Renamed { from: path("old/tokens.rs"), path: path("src/parser/tokens.rs") },
        ChangedFile::Copied { from: path("shared/helper.rs"), path: path("src/parser/helper.rs") },
        ChangedFile::Renamed { from: path("src/parser/old.rs"), path: path("src/parser/new.rs") },
    ];
    let page = Page::review(&"tree".parse::<ChangeId>().unwrap(), &files);
    expect![[r"
        [Label|src/parser/]
          [Copied|helper.rs][Muted| ← copied from shared/helper.rs] => review:tree:src/parser/helper.rs
          [Renamed|new.rs][Muted| ← moved from old.rs] => review:tree:src/parser/new.rs
          [Renamed|tokens.rs][Muted| ← moved from old/tokens.rs] => review:tree:src/parser/tokens.rs
    "]]
    .assert_eq(&markup(&page));
    let targets: Vec<_> = page.lines.iter().filter_map(|line| line.target.as_ref()).collect();
    assert_eq!(targets.len(), files.len());
    for file in files {
        assert!(
            targets.iter().any(|target| matches!(target, Target::ReviewDiff { file: actual, .. } if *actual == file))
        );
    }
}

#[test]
fn file_tree_preserves_a_deleted_file_replaced_by_a_directory() {
    let path = |p: &str| p.parse().unwrap();
    let files = [
        ChangedFile::Deleted { path: path("src/item") },
        ChangedFile::Added { path: path("src/item/child.rs") },
        ChangedFile::Modified { path: path("src/item-other.rs") },
    ];
    let page = Page::workspace(&"tree".parse::<ChangeId>().unwrap(), &files);
    expect![[r"
        [Label|src/]
          [Deleted|item] => workspace:tree:src/item
          [Label|item/]
            [Added|child.rs] => workspace:tree:src/item/child.rs
          [Modified|item-other.rs] => workspace:tree:src/item-other.rs
    "]]
    .assert_eq(&markup(&page));
    expect!["[Fold { start: 0, end: 4 }, Fold { start: 2, end: 3 }]"].assert_eq(&format!("{:?}", page.folds));
}
