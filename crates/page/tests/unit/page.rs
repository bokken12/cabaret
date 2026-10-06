use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write,
    path::Path,
};

use cabaret_agents::{Session, SessionId, Status};
use cabaret_config::Hints;
use cabaret_page::{DiffView, NextStep, Page, Segment, TabCounts, Tag, Target};
use cabaret_types::{ChangeId, ChangeSnapshot, ChangedFile, Identity, LineCounts, RevisionId, TimestampMs};
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

fn uncounted(files: &[ChangedFile]) -> Vec<(ChangedFile, Option<LineCounts>)> {
    files.iter().map(|file| (file.clone(), None)).collect()
}

fn viewer() -> Identity { Identity("alice@example.com".into()) }

fn describe(target: &Target) -> String {
    let paths = |files: &[ChangedFile]| {
        files.iter().map(|file| file.paths().last().unwrap().to_string()).collect::<Vec<_>>().join(",")
    };
    match target {
        Target::Change { change, context } => format!("{}:{change}", if *context { "context" } else { "change" }),
        Target::Home { section } => format!("home:{section:?}"),
        Target::Files { view, change } => format!("files:{}:{change}", format!("{view:?}").to_lowercase()),
        Target::Diff { view, change, files } => {
            format!("{}:{change}:{}", format!("{view:?}").to_lowercase(), paths(files))
        }
        Target::Title { change } => format!("title:{change}"),
        Target::Description { change } => format!("description:{change}"),
        Target::Session { change, session } => format!("session:{change}:{session}"),
    }
}

/// Each segment as `text`, `[Tag|text]`, or `[Tag>target|text]`; a line's own target follows `=>`,
/// and the cursor's line, unless it starts at the top, ends with `<cursor>`.
pub fn markup(page: &Page) -> String {
    let mut out = String::new();
    for (i, line) in page.lines.iter().enumerate() {
        for Segment { text, tag, target } in &line.segments {
            match (tag, target) {
                (None, None) => out.push_str(text),
                (tag, target) => {
                    out.push('[');
                    if let Some(tag) = tag {
                        write!(out, "{tag:?}").unwrap();
                    }
                    if let Some(target) = target {
                        write!(out, ">{}", describe(target)).unwrap();
                    }
                    write!(out, "|{text}]").unwrap();
                }
            }
        }
        if let Some(target) = &line.target {
            write!(out, " => {}", describe(target)).unwrap();
        }
        if page.cursor != 0 && u32::try_from(i).unwrap() == page.cursor {
            out.push_str(" <cursor>");
        }
        out.push('\n');
    }
    out
}

#[test]
fn a_show_page_is_headed_by_its_title_and_points_to_parents_by_id() {
    let change = snapshot(
        Some("Add the parser"),
        Some("A recursive descent parser.\n\nWith tests."),
        &["alice@example.com", "bob@example.com"],
        &["lexer", "tokens"],
    );
    let page = Page::show(
        &"add-parser".parse::<ChangeId>().unwrap(),
        &change,
        Some(Path::new("/repo/add-parser")),
        None,
        &viewer(),
        Hints::Shown,
    );
    expect![[r#"
        [Heading|Add the parser] => title:add-parser

        A recursive descent parser. => description:add-parser
         => description:add-parser
        With tests. => description:add-parser

        [Label|Id:] [ChangeId|add-parser]
        [Label|Status:] open
        [Label|Owners:] alice@example.com, bob@example.com
        [Label|Parents:] [ChangeId>change:lexer|lexer], [ChangeId>change:tokens|tokens]
        [Label|Tip:] [Revision|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]
        [Label|Bases:] [Revision|1111111111111111111111111111111111111111], [Revision|2222222222222222222222222222222222222222]
        [Label|Workspace:] /repo/add-parser


        [Label|Next step:] [Muted|(none)]
    "#]]
    .assert_eq(&markup(&page));
    expect![[r#"
        Add the parser

        A recursive descent parser.

        With tests.

        Id: add-parser
        Status: open
        Owners: alice@example.com, bob@example.com
        Parents: lexer, tokens
        Tip: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Bases: 1111111111111111111111111111111111111111, 2222222222222222222222222222222222222222
        Workspace: /repo/add-parser


        Next step: (none)
    "#]]
    .assert_eq(&page.to_string());
}

#[test]
fn a_bare_show_page_marks_what_is_missing() {
    let page = Page::show(
        &"bare".parse::<ChangeId>().unwrap(),
        &snapshot(None, None, &[], &[]),
        None,
        None,
        &viewer(),
        Hints::Shown,
    );
    expect![[r#"
        [Heading|bare] => title:bare

        [Muted|(no description)] => description:bare

        [Label|Id:] [ChangeId|bare]
        [Label|Status:] open
        [Label|Owners:] [Muted|(none)]
        [Label|Parents:] [Muted|(none)]
        [Label|Tip:] [Revision|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]
        [Label|Bases:] [Muted|(none)]
        [Label|Workspace:] [Muted|(none)]


        [Label|Next step:] [Muted|(none)]
    "#]]
    .assert_eq(&markup(&page));
}

#[test]
fn show_page_status_is_archived_else_permanent_else_open() {
    let status = |archived: bool, permanent: bool| {
        let change = ChangeSnapshot { archived, permanent, ..snapshot(None, None, &[], &[]) };
        let page = Page::show(&"trunk".parse::<ChangeId>().unwrap(), &change, None, None, &viewer(), Hints::Shown);
        page.to_string().lines().nth(5).unwrap().to_owned()
    };
    expect!["Status: open"].assert_eq(&status(false, false));
    expect!["Status: permanent"].assert_eq(&status(false, true));
    expect!["Status: archived"].assert_eq(&status(true, false));
    expect!["Status: archived"].assert_eq(&status(true, true));
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
    let page = Page::files(
        &"change".parse::<ChangeId>().unwrap(),
        Some("Tidy the parser"),
        DiffView::Diff,
        &uncounted(&files),
    );
    expect![[r#"
        [Heading|Tidy the parser][Muted| · changed files]

        ○ [Renamed|b.rs][Muted| ← moved from a.rs] => diff:change:b.rs <cursor>
        ○ [Copied|d.rs][Muted| ← copied from c.rs] => diff:change:d.rs
        ◌ [Label|src/] => diff:change:src/lib.rs,src/new.rs,src/old.rs
        ├─○ [Modified|lib.rs] => diff:change:src/lib.rs
        ├─○ [Added|new.rs] => diff:change:src/new.rs
        ╰─○ [Deleted|old.rs] => diff:change:src/old.rs
    "#]]
    .assert_eq(&markup(&page));
}

#[test]
fn an_empty_diff_page_says_so() {
    let page = Page::files(&"empty".parse::<ChangeId>().unwrap(), None, DiffView::Diff, &[]);
    expect![[r#"
        [Heading|empty][Muted| · changed files]

        [Muted|no changed files]
    "#]]
    .assert_eq(&markup(&page));
}

#[test]
fn a_review_page_targets_each_unreviewed_file() {
    let path = |path: &str| path.parse().unwrap();
    let files = [ChangedFile::Modified { path: path("src/lib.rs") }, ChangedFile::Added { path: path("src/new.rs") }];
    let page = Page::files(&"change".parse::<ChangeId>().unwrap(), None, DiffView::Review, &uncounted(&files));
    expect![[r#"
        [Heading|change][Muted| · unreviewed files]

        ◌ [Label|src/] => review:change:src/lib.rs,src/new.rs
        ├─○ [Modified|lib.rs] => review:change:src/lib.rs <cursor>
        ╰─○ [Added|new.rs] => review:change:src/new.rs
    "#]]
    .assert_eq(&markup(&page));
}

#[test]
fn an_empty_review_page_says_so() {
    let page = Page::files(&"reviewed".parse::<ChangeId>().unwrap(), None, DiffView::Review, &[]);
    expect![[r#"
        [Heading|reviewed][Muted| · unreviewed files]

        [Muted|no unreviewed files]
    "#]]
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
    expect![[r#"
        [Heading|change][Muted| · uncommitted files]

        ○ [Renamed|b.rs][Muted| ← moved from a.rs] => workspace:change:b.rs <cursor>
        ○ [Modified|src/lib.rs] => workspace:change:src/lib.rs
    "#]]
    .assert_eq(&markup(&Page::files(&change, None, DiffView::Workspace, &uncounted(&files))));
    expect![[r#"
        [Heading|change][Muted| · uncommitted files]

        [Muted|no uncommitted files]
    "#]]
    .assert_eq(&markup(&Page::files(&change, None, DiffView::Workspace, &[])));
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
    expect![[r#"

        [Label|Sessions:]
          Fix the parser[Muted| · just now, busy] => session:parser:a1
          Add tests[Muted| · 42m ago, idle] => session:parser:b2
          c3[Muted| · 3h ago, running] => session:parser:c3
          Old[Muted| · 9d ago] => session:parser:d4
    "#]]
    .assert_eq(&markup(&page));
    expect![["[Fold { start: 1, end: 5 }]"]].assert_eq(&format!("{:?}", page.folds));
    expect![[r#"

        [Label|Sessions:] [Muted|(none)]
    "#]]
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
    let page = Page::files(&change, None, DiffView::Diff, &uncounted(&files));
    expect![[r#"
        [Heading|tree][Muted| · changed files]

        ○ [Modified|README.md] => diff:tree:README.md <cursor>
        ◌ [Label|src/] => diff:tree:src/main.rs,src/parser/expression.rs,src/parser/tokens.rs
        ├─○ [Modified|main.rs] => diff:tree:src/main.rs
        ╰─◌ [Label|parser/] => diff:tree:src/parser/expression.rs,src/parser/tokens.rs
          ├─○ [Modified|expression.rs] => diff:tree:src/parser/expression.rs
          ╰─○ [Modified|tokens.rs] => diff:tree:src/parser/tokens.rs
        ○ [Modified|tests/parser/basic.rs] => diff:tree:tests/parser/basic.rs
    "#]]
    .assert_eq(&markup(&page));
    expect!["[Fold { start: 3, end: 7 }, Fold { start: 5, end: 7 }]"].assert_eq(&format!("{:?}", page.folds));
    // Every view has the same shape; only its heading and file targets differ.
    let tree = |page: &Page| page.to_string().lines().skip(1).map(str::to_owned).collect::<Vec<_>>();
    for other in [
        Page::files(&change, None, DiffView::Review, &uncounted(&files)),
        Page::files(&change, None, DiffView::Workspace, &uncounted(&files)),
    ] {
        assert_eq!(tree(&page), tree(&other));
        assert_eq!(page.folds, other.folds);
    }
    let single = Page::files(&change, None, DiffView::Review, &uncounted(&files[..1]));
    expect![[r#"
        tree · unreviewed files

        ○ tests/parser/basic.rs
    "#]]
    .assert_eq(&single.to_string());
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
    let page = Page::files(&"tree".parse::<ChangeId>().unwrap(), None, DiffView::Review, &uncounted(&files));
    expect![[r#"
        [Heading|tree][Muted| · unreviewed files]

        ◌ [Label|src/parser/] => review:tree:src/parser/helper.rs,src/parser/new.rs,src/parser/tokens.rs
        ├─○ [Copied|helper.rs][Muted| ← copied from shared/helper.rs] => review:tree:src/parser/helper.rs <cursor>
        ├─○ [Renamed|new.rs][Muted| ← moved from old.rs] => review:tree:src/parser/new.rs
        ╰─○ [Renamed|tokens.rs][Muted| ← moved from old/tokens.rs] => review:tree:src/parser/tokens.rs
    "#]]
    .assert_eq(&markup(&page));
    let targets: Vec<_> = page.lines.iter().filter_map(|line| line.target.as_ref()).collect();
    for file in files {
        assert!(targets.iter().any(
            |target| matches!(target, Target::Diff { view: DiffView::Review, files, .. } if *files == [file.clone()])
        ));
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
    let page = Page::files(&"tree".parse::<ChangeId>().unwrap(), None, DiffView::Workspace, &uncounted(&files));
    expect![[r#"
        [Heading|tree][Muted| · uncommitted files]

        ◌ [Label|src/] => workspace:tree:src/item,src/item/child.rs,src/item-other.rs
        ├─○ [Deleted|item] => workspace:tree:src/item <cursor>
        ├─◌ [Label|item/] => workspace:tree:src/item/child.rs
        │ ╰─○ [Added|child.rs] => workspace:tree:src/item/child.rs
        ╰─○ [Modified|item-other.rs] => workspace:tree:src/item-other.rs
    "#]]
    .assert_eq(&markup(&page));
    expect!["[Fold { start: 2, end: 6 }, Fold { start: 4, end: 5 }]"].assert_eq(&format!("{:?}", page.folds));
}

#[test]
fn tabs_underline_showing_page_and_mute_empty_views() {
    let change = "change".parse::<ChangeId>().unwrap();
    let counts = TabCounts { diff: 12, review: 0, workspace: None };
    let page = Page::change_tabs(&change, Some(DiffView::Diff), counts, Hints::Shown);
    expect![[r#"
        [Muted| ╭──────────┬─────────────┬──────────────┬───────────────╮]
        [Muted| │][>change:change| overview ][Muted|│][Heading>files:diff:change| [d] diff 12 ][Muted|│][Muted>files:review:change| [r] review 0 ][Muted|│][Muted>files:workspace:change| [w] workspace ][Muted|│]
        [Muted|─┴──────────┘             └──────────────┴───────────────┴─]
    "#]].assert_eq(&markup(&page));
    expect![[r#"
         ╭──────────┬─────────────┬──────────────┬───────────────╮
         │ overview │ [d] diff 12 │ [r] review 0 │ [w] workspace │
        ─┴──────────┘             └──────────────┴───────────────┴─
    "#]]
    .assert_eq(&page.to_string());
}

#[test]
fn show_page_tab_is_overview() {
    let change = "change".parse::<ChangeId>().unwrap();
    let page = Page::change_tabs(&change, None, TabCounts { diff: 1, review: 1, workspace: Some(2) }, Hints::Shown);
    expect![[r#"
         ╭──────────┬────────────┬──────────────┬─────────────────╮
         │ overview │ [d] diff 1 │ [r] review 1 │ [w] workspace 2 │
        ─┘          └────────────┴──────────────┴─────────────────┴─
    "#]]
    .assert_eq(&page.to_string());
}

#[test]
fn hidden_hints_leave_keys_off_tabs() {
    let change = "change".parse::<ChangeId>().unwrap();
    let page = Page::change_tabs(&change, None, TabCounts { diff: 1, review: 1, workspace: None }, Hints::Hidden);
    expect![[r#"
         ╭──────────┬────────┬──────────┬───────────╮
         │ overview │ diff 1 │ review 1 │ workspace │
        ─┘          └────────┴──────────┴───────────┴─
    "#]]
    .assert_eq(&page.to_string());
}

#[test]
fn show_page_next_step_links_changes_and_hints_keys_viewer_may_press() {
    let changes = |ids: &[&str]| ids.iter().map(|id| id.parse::<ChangeId>().unwrap()).collect::<BTreeSet<_>>();
    let identities = |ids: &[&str]| ids.iter().map(|id| Identity((*id).into())).collect::<BTreeSet<_>>();
    let steps = [
        NextStep::AddCode,
        NextStep::ResolveConflicts { files: ["a.txt", "b.txt"].map(|file| file.parse().unwrap()).into() },
        NextStep::ResolveParentConflicts { parents: changes(&["lexer"]) },
        NextStep::Rebase { parents: changes(&["lexer", "tokens"]) },
        NextStep::Review { reviewers: identities(&["alice@example.com", "bob@example.com"]) },
        NextStep::Review { reviewers: identities(&["bob@example.com"]) },
        NextStep::LandParents { parents: changes(&["lexer", "tokens"]) },
        NextStep::Land { into: "lexer".parse().unwrap() },
    ];
    let mut out = String::new();
    for (heading, owners) in [("owned by viewer", "alice@example.com"), ("owned by another", "bob@example.com")] {
        writeln!(out, "{heading}:").unwrap();
        let change = snapshot(None, None, &[owners], &[]);
        for step in &steps {
            let page =
                Page::show(&"parser".parse::<ChangeId>().unwrap(), &change, None, Some(step), &viewer(), Hints::Shown);
            let line = page
                .lines
                .into_iter()
                .find(|line| line.segments.first().is_some_and(|label| label.text == "Next step:"))
                .unwrap();
            let line = Page { lines: vec![line], ..Page::default() };
            out.push_str(&markup(&line));
        }
    }
    expect![[r#"
        owned by viewer:
        [NextStepLabel|Next step:] [NextStep|add code]
        [NextStepLabel|Next step:] [NextStep|resolve conflicts in a.txt, b.txt]
        [NextStepLabel|Next step:] [Shortcut|[^]] [NextStep|resolve conflicts in] [ChangeId>change:lexer|lexer]
        [NextStepLabel|Next step:] [Shortcut|[!r]] [NextStep|rebase onto] [ChangeId>change:lexer|lexer], [ChangeId>change:tokens|tokens]
        [NextStepLabel|Next step:] [Shortcut|[r]] [NextStep|review by alice@example.com, bob@example.com]
        [NextStepLabel|Next step:] [NextStep|review by bob@example.com]
        [NextStepLabel|Next step:] [Shortcut|[^]] [NextStep|land parents] [ChangeId>change:lexer|lexer], [ChangeId>change:tokens|tokens]
        [NextStepLabel|Next step:] [Shortcut|[!l]] [NextStep|land into] [ChangeId>change:lexer|lexer]
        owned by another:
        [NextStepLabel|Next step:] [NextStep|add code]
        [NextStepLabel|Next step:] [NextStep|resolve conflicts in a.txt, b.txt]
        [NextStepLabel|Next step:] [Shortcut|[^]] [NextStep|resolve conflicts in] [ChangeId>change:lexer|lexer]
        [NextStepLabel|Next step:] [NextStep|rebase onto] [ChangeId>change:lexer|lexer], [ChangeId>change:tokens|tokens]
        [NextStepLabel|Next step:] [Shortcut|[r]] [NextStep|review by alice@example.com, bob@example.com]
        [NextStepLabel|Next step:] [NextStep|review by bob@example.com]
        [NextStepLabel|Next step:] [Shortcut|[^]] [NextStep|land parents] [ChangeId>change:lexer|lexer], [ChangeId>change:tokens|tokens]
        [NextStepLabel|Next step:] [NextStep|land into] [ChangeId>change:lexer|lexer]
    "#]]
    .assert_eq(&out);
}

#[test]
fn hidden_next_step_hint_keeps_the_action_and_parent_link() {
    let page = Page::show(
        &"parser".parse::<ChangeId>().unwrap(),
        &snapshot(None, None, &["alice@example.com"], &["main"]),
        Some(Path::new("/repo/parser")),
        Some(&NextStep::Rebase { parents: ["main".parse().unwrap()].into() }),
        &viewer(),
        Hints::Hidden,
    );
    let line = page.lines.last().unwrap();
    assert!(line.segments.iter().all(|segment| segment.tag != Some(Tag::Shortcut)));
    expect![[r#"
        [NextStepLabel|Next step:] [NextStep|rebase onto] [ChangeId>change:main|main]
    "#]]
    .assert_eq(&markup(&Page { lines: vec![line.clone()], ..Page::default() }));
}
