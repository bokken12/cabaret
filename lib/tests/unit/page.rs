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
        [Heading|add-parser] — [Heading|Add the parser]

        A recursive descent parser.

        With tests.

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
        [Heading|bare]

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
        page.to_string().lines().nth(2).unwrap().to_owned()
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
        [Added|src/new.rs] => diff:change:src/new.rs
        [Deleted|src/old.rs] => diff:change:src/old.rs
        [Modified|src/lib.rs] => diff:change:src/lib.rs
        [Renamed|a.rs -> b.rs] => diff:change:b.rs
        [Copied|c.rs => d.rs] => diff:change:d.rs
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
