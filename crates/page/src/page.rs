//! Pages are what frontends display: lines of text cut into tagged segments, where a segment or
//! a whole line may name where it leads. Frontends paint tags in their own style and follow the
//! target under the cursor.

use std::{collections::BTreeSet, fmt, path::Path};

use cabaret_agents::{Session, SessionId, Status};
use cabaret_config::Hints;
use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Identity, LineCounts, RepoPath, RevisionId, TimestampMs,
};
use nonempty_collections::NEBTreeSet;

use crate::{file_tree::FileTree, home::HomeSection};

/// The first thing standing between a change and landing, in the order they must be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NextStep {
    /// Its tip adds nothing to its base, so there is nothing to land.
    AddCode,
    /// Files its tip holds conflict markers in; they are resolved before anything more is merged.
    ResolveConflicts {
        files: NEBTreeSet<RepoPath>,
    },
    /// Parents it lags behind that hold conflict markers of their own, which a rebase would take on.
    ResolveParentConflicts {
        parents: NEBTreeSet<ChangeId>,
    },
    /// Parents whose tips its bases lag behind.
    Rebase {
        parents: NEBTreeSet<ChangeId>,
    },
    /// Owners with files left to review, since owners are to review every file of their changes.
    Review {
        reviewers: NEBTreeSet<Identity>,
    },
    /// A change lands into one parent, so several must first coalesce by landing.
    LandParents {
        parents: NEBTreeSet<ChangeId>,
    },
    Land {
        into: ChangeId,
    },
}

/// What a piece of text is, for frontends to style.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum))]
pub enum Tag {
    Heading,
    ChangeId,
    Revision,
    Label,
    Accent,
    Shortcut,
    Muted,
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
}

/// The three diffs of a change: `Diff` from its base to its tip, `Review` from the merge of its
/// bases with what the reviewer last marked reviewed to its tip, and `Workspace` from its tip to
/// what the workspace holding it has on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum = "lowercase"))]
pub enum DiffView {
    Diff,
    Review,
    Workspace,
}

impl DiffView {
    /// What the files this view diffs are, to the reader.
    pub fn kind(self) -> &'static str {
        match self {
            Self::Diff => "changed",
            Self::Review => "unreviewed",
            Self::Workspace => "uncommitted",
        }
    }
}

/// Where a piece of text leads.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(discriminant = "kind"))]
pub enum Target {
    Change {
        change: ChangeId,
        /// Drawn only to place the changes around it, as a home graph's ancestors are, so left
        /// out when a selection spans it.
        context: bool,
    },
    /// One section of the home page.
    Home { section: HomeSection },
    /// The page listing the files `change`'s `view` diffs.
    Files { view: DiffView, change: ChangeId },
    /// Files of `change`, as its `view` diffs them.
    Diff { view: DiffView, change: ChangeId, files: Vec<ChangedFile> },
    /// The title of `change`, for editing.
    Title { change: ChangeId },
    /// The description of `change`, for editing.
    Description { change: ChangeId },
    /// A Claude Code session that worked on `change`.
    Session { change: ChangeId, session: SessionId },
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct Segment {
    pub text: String,
    pub tag: Option<Tag>,
    pub target: Option<Target>,
}

impl Segment {
    pub fn plain(text: impl Into<String>) -> Self { Self { text: text.into(), tag: None, target: None } }

    pub fn tagged(text: impl Into<String>, tag: Tag) -> Self { Self { tag: Some(tag), ..Self::plain(text) } }

    pub fn leading_to(self, target: Target) -> Self { Self { target: Some(target), ..self } }
}

/// A targeted segment under the cursor takes precedence over the line's own target.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct Line {
    pub segments: Vec<Segment>,
    pub target: Option<Target>,
}

impl Line {
    pub fn plain(text: impl Into<String>) -> Self { Self::default().push(Segment::plain(text)) }

    pub fn push(mut self, segment: Segment) -> Self {
        self.segments.push(segment);
        self
    }

    pub fn leading_to(self, target: Target) -> Self { Self { target: Some(target), ..self } }
}

/// Lines `start + 1..=end` may fold away under line `start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct Fold {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct Page {
    pub lines: Vec<Line>,
    /// Sorted by start; folds nest or stay disjoint.
    pub folds: Vec<Fold>,
    /// The line to start the cursor on when there is no position to return to.
    pub cursor: u32,
}

/// How many files each view of a change diffs; `workspace` is `None` when the change is checked
/// out nowhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TabCounts {
    pub diff: usize,
    pub review: usize,
    pub workspace: Option<usize>,
}

/// One tab of a [`Page::strip`]: `showing` for the page it heads, `muted` when it leads to
/// nothing.
pub struct Tab {
    pub text: String,
    pub showing: bool,
    pub muted: bool,
    pub target: Target,
}

impl Page {
    /// Headed by the change's title, with its id on a line of its own. Parents are listed by id,
    /// as pointers out should be unique. `workspace` is the working directory of the workspace
    /// holding the change, if any. When `hints` are shown, the next step names the key frontends
    /// bind to taking it, where there is one and it is `viewer`'s to take: reviewing for its
    /// reviewers, acting on the change itself for owners, and stepping up to parents for anyone.
    pub fn show(
        id: &ChangeIdRef,
        change: &ChangeSnapshot,
        workspace: Option<&Path>,
        next_step: Option<&NextStep>,
        viewer: &Identity,
        hints: Hints,
    ) -> Self {
        let heading = Line::default().push(Segment::tagged(name(id, change.title.as_deref()), Tag::Heading));
        let mut lines = vec![heading.leading_to(Target::Title { change: id.to_owned() }), Line::default()];
        let description = || Target::Description { change: id.to_owned() };
        match &change.description {
            Some(text) => lines.extend(text.lines().map(|line| Line::plain(line).leading_to(description()))),
            None => lines
                .push(Line::default().push(Segment::tagged("(no description)", Tag::Muted)).leading_to(description())),
        }
        lines.push(Line::default());
        let status = match (change.archived, change.permanent) {
            (true, _) => "archived",
            (false, true) => "permanent",
            (false, false) => "open",
        };
        lines.push(list("Id:", std::iter::once(Segment::tagged(id.to_string(), Tag::ChangeId))));
        lines.push(list("Status:", std::iter::once(Segment::plain(status))));
        lines.push(list("Owners:", change.owners.iter().map(|owner| Segment::plain(owner.to_string()))));
        lines.push(list(
            "Parents:",
            change.parents.iter().map(|parent| {
                Segment::tagged(parent.to_string(), Tag::ChangeId)
                    .leading_to(Target::Change { change: parent.clone(), context: false })
            }),
        ));
        let revision = |revision: &RevisionId| Segment::tagged(revision.to_string(), Tag::Revision);
        lines.push(list("Tip:", std::iter::once(revision(&change.tip))));
        lines.push(list("Bases:", change.bases.iter().map(revision)));
        lines.push(list("Workspace:", workspace.map(|path| Segment::plain(path.display().to_string())).into_iter()));
        lines.extend([Line::default(), Line::default()]);
        lines.push(self::next_step(next_step, change.owners.contains(viewer), viewer, hints));
        Self { lines, ..Self::default() }
    }

    /// The files `change`'s `view` diffs, headed by the change's name; below, each file leads to
    /// its own diff and each folder to all under it. The cursor starts on the first file listed,
    /// so that diffs can be read in order from the top. Files and folders show their line counts
    /// where they were counted.
    pub fn files(
        change: &ChangeIdRef,
        title: Option<&str>,
        view: DiffView,
        files: &[(ChangedFile, Option<LineCounts>)],
    ) -> Self {
        let kind = view.kind();
        let target = |files: &[&ChangedFile]| Target::Diff {
            view,
            change: change.to_owned(),
            files: files.iter().map(|&file| file.clone()).collect(),
        };
        let tree = FileTree::new(files);
        let heading = Line::default()
            .push(Segment::tagged(name(change, title), Tag::Heading))
            .push(Segment::tagged(format!(" · {kind} files"), Tag::Muted));
        let mut page = Self { lines: vec![heading, Line::default()], ..Self::default() };
        page.append(match files.is_empty() {
            true => Self::message(format!("no {kind} files")),
            false => tree.render_with_targets(|files| Some(target(files))),
        });
        if let Some(&first) = tree.listed_files().first() {
            let first = Some(target(&[first]));
            let row = page.lines.iter().position(|line| line.target == first).expect("every listed file has a row");
            page.cursor = u32::try_from(row).expect("pages are short");
        }
        page
    }

    /// A strip of tabs over a change's pages, its show page first, then one per view naming how
    /// many files it lists and, when `hints` are shown, the key frontends bind to it. The tab of
    /// `view`, the page showing (`None` for the show page), is underlined; a view with nothing to
    /// list is muted.
    pub fn change_tabs(change: &ChangeIdRef, view: Option<DiffView>, counts: TabCounts, hints: Hints) -> Self {
        let files = |tab: DiffView, key: char, name: &str, count: Option<usize>| {
            let hint = match hints {
                Hints::Shown => format!("[{key}] "),
                Hints::Hidden => String::new(),
            };
            Tab {
                text: match count {
                    Some(count) => format!("{hint}{name} {count}"),
                    None => format!("{hint}{name}"),
                },
                showing: view == Some(tab),
                muted: count.is_none_or(|count| count == 0),
                target: Target::Files { view: tab, change: change.to_owned() },
            }
        };
        Self::strip([
            Tab {
                text: "overview".to_owned(),
                showing: view.is_none(),
                muted: false,
                target: Target::Change { change: change.to_owned(), context: false },
            },
            files(DiffView::Diff, 'd', "diff", Some(counts.diff)),
            files(DiffView::Review, 'r', "review", Some(counts.review)),
            files(DiffView::Workspace, 'w', "workspace", counts.workspace),
        ])
    }

    /// Tabs drawn as boxes sharing their borders, over a baseline left open under the one showing.
    pub fn strip(tabs: impl IntoIterator<Item = Tab>) -> Self {
        let tabs: Vec<Tab> = tabs.into_iter().collect();
        let width = |tab: &Tab| tab.text.chars().count() + 2;
        let showing = |i: Option<usize>| i.and_then(|i| tabs.get(i)).is_some_and(|tab| tab.showing);
        // The border left of tab `i`, as it meets the baseline.
        let foot = |i: usize| match (showing(i.checked_sub(1)), showing(Some(i))) {
            (true, _) => '└',
            (_, true) => '┘',
            _ => '┴',
        };
        let mut top = String::from(" ╭");
        let mut bottom = String::from("─");
        for (i, tab) in tabs.iter().enumerate() {
            top.push_str(&"─".repeat(width(tab)));
            top.push(if i + 1 == tabs.len() { '╮' } else { '┬' });
            bottom.push(foot(i));
            bottom.push_str(&(if tab.showing { " " } else { "─" }).repeat(width(tab)));
        }
        bottom.push(foot(tabs.len()));
        bottom.push('─');
        let border = |text: &str| Segment::tagged(text, Tag::Muted);
        let mut labels = Line::default().push(border(" │"));
        for Tab { text, showing, muted, target } in tabs {
            let tag = match (showing, muted) {
                (true, _) => Some(Tag::Heading),
                (false, true) => Some(Tag::Muted),
                (false, false) => None,
            };
            labels = labels
                .push(Segment { tag, ..Segment::plain(format!(" {text} ")).leading_to(target) })
                .push(border("│"));
        }
        let rule = |text: String| Line::default().push(Segment::tagged(text, Tag::Muted));
        Self { lines: vec![rule(top), labels, rule(bottom)], ..Self::default() }
    }

    /// The tail of a show page: one line per Claude Code session that worked on `change`, each
    /// leading to itself, folding under their label. Sessions are listed as given, so callers
    /// order them.
    pub fn sessions(change: &ChangeIdRef, sessions: &[Session], now: TimestampMs) -> Self {
        if sessions.is_empty() {
            return Self { lines: vec![Line::default(), list("Sessions:", std::iter::empty())], ..Self::default() };
        }
        let mut lines = vec![Line::default(), Line::default().push(Segment::tagged("Sessions:", Tag::Label))];
        for session in sessions {
            let title = session.title.clone().unwrap_or_else(|| session.id.to_string());
            let mut note = format!(" · {}", ago(session.last_active, now));
            match session.live {
                Some(Status::Busy) => note.push_str(", busy"),
                Some(Status::Idle) => note.push_str(", idle"),
                Some(Status::Unknown) => note.push_str(", running"),
                None => {}
            }
            lines.push(
                Line::default()
                    .push(Segment::plain(format!("  {title}")))
                    .push(Segment::tagged(note, Tag::Muted))
                    .leading_to(Target::Session { change: change.to_owned(), session: session.id.clone() }),
            );
        }
        let end = u32::try_from(lines.len() - 1).expect("pages are short");
        Self { lines, folds: vec![Fold { start: 1, end }], ..Self::default() }
    }

    /// A page of one muted line, for when there is nothing to show.
    pub fn message(text: impl Into<String>) -> Self {
        Self { lines: vec![Line::default().push(Segment::tagged(text, Tag::Muted))], ..Self::default() }
    }

    /// Continue with `other`'s lines, its folds moved down to them.
    pub fn append(&mut self, other: Self) {
        let offset = u32::try_from(self.lines.len()).expect("pages are short");
        self.lines.extend(other.lines);
        self.folds
            .extend(other.folds.into_iter().map(|fold| Fold { start: fold.start + offset, end: fold.end + offset }));
    }
}

/// `Next step: what to do`, preceded by the key taking it when `hints` are shown and it is
/// `viewer`'s to take.
fn next_step(step: Option<&NextStep>, owner: bool, viewer: &Identity, hints: Hints) -> Line {
    let Some(step) = step else { return list("Next step:", std::iter::empty()) };
    let (key, text, changes) = match step {
        NextStep::AddCode => (None, "add code".to_owned(), BTreeSet::new()),
        NextStep::ResolveConflicts { files } => {
            (None, format!("resolve conflicts in {}", joined(files)), BTreeSet::new())
        }
        NextStep::ResolveParentConflicts { parents } => {
            (Some("^"), "resolve conflicts in".to_owned(), parents.clone().into())
        }
        NextStep::Rebase { parents } => (owner.then_some("!r"), "rebase onto".to_owned(), parents.clone().into()),
        NextStep::Review { reviewers } => {
            (reviewers.contains(viewer).then_some("r"), format!("review by {}", joined(reviewers)), BTreeSet::new())
        }
        NextStep::LandParents { parents } => (Some("^"), "land parents".to_owned(), parents.clone().into()),
        NextStep::Land { into } => (owner.then_some("!l"), "land into".to_owned(), BTreeSet::from([into.clone()])),
    };
    let mut line = Line::default().push(Segment::tagged("Next step:", Tag::Accent)).push(Segment::plain(" "));
    if let (Some(key), Hints::Shown) = (key, hints) {
        line = line.push(Segment::tagged(format!("[{key}]"), Tag::Shortcut)).push(Segment::plain(" "));
    }
    line = line.push(Segment::tagged(text, Tag::Accent));
    for (i, change) in changes.into_iter().enumerate() {
        line = line.push(Segment::plain(if i == 0 { " " } else { ", " })).push(
            Segment::tagged(change.to_string(), Tag::ChangeId).leading_to(Target::Change { change, context: false }),
        );
    }
    line
}

/// How long before `now` something happened, coarsely: the reader wants to know whether a session
/// is still warm, not the minute it stopped.
fn ago(then: TimestampMs, now: TimestampMs) -> String {
    let seconds = now.0.saturating_sub(then.0) / 1000;
    match seconds {
        s if s < 60 => "just now".to_owned(),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86400 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86400),
    }
}

/// `Label: a, b` or `Label: (none)`.
fn list(label: &str, items: impl Iterator<Item = Segment>) -> Line {
    let mut line = Line::default().push(Segment::tagged(label, Tag::Label)).push(Segment::plain(" "));
    let mut items = items.peekable();
    if items.peek().is_none() {
        return line.push(Segment::tagged("(none)", Tag::Muted));
    }
    for (i, item) in items.enumerate() {
        if i > 0 {
            line = line.push(Segment::plain(", "));
        }
        line = line.push(item);
    }
    line
}

/// The page as plain text, one line per line.
impl fmt::Display for Page {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for line in &self.lines {
            for segment in &line.segments {
                f.write_str(&segment.text)?;
            }
            f.write_str("\n")?;
        }
        Ok(())
    }
}

/// What a change is called wherever it is shown: its title, or its id when it has none.
pub fn name(id: &ChangeIdRef, title: Option<&str>) -> String { title.map_or_else(|| id.to_string(), str::to_owned) }

/// `a, b, c`.
fn joined(items: impl IntoIterator<Item: fmt::Display>) -> String {
    items.into_iter().map(|item| item.to_string()).collect::<Vec<_>>().join(", ")
}
