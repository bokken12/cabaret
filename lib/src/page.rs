//! Pages are what frontends display: lines of text cut into tagged segments, where a segment or
//! a whole line may name where it leads. Frontends paint tags in their own style and follow the
//! target under the cursor.
// TODO-someday(joel): move page and UI details to a separate crate?

use std::{fmt, path::Path};

use cabaret_agents::{Session, SessionId, Status};
use cabaret_types::{ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, RevisionId, TimestampMs};

use crate::file_tree::FileTree;

/// What a piece of text is, for frontends to style.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum))]
pub enum Tag {
    Heading,
    ChangeId,
    Revision,
    Label,
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
pub enum View {
    Diff,
    Review,
    Workspace,
}

/// Where a piece of text leads.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(discriminant = "kind"))]
pub enum Target {
    Change {
        change: ChangeId,
    },
    /// Files of `change`, as its `view` diffs them.
    Diff {
        view: View,
        change: ChangeId,
        files: Vec<ChangedFile>,
    },
    /// The title of `change`, for editing.
    Title {
        change: ChangeId,
    },
    /// The description of `change`, for editing.
    Description {
        change: ChangeId,
    },
    /// A Claude Code session that worked on `change`.
    Session {
        change: ChangeId,
        session: SessionId,
    },
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
}

impl Page {
    /// Headed by the change's title, with its id on a line of its own. Parents are listed by id,
    /// as pointers out should be unique. `workspace` is the working directory of the workspace
    /// holding the change, if any.
    pub fn show(id: &ChangeIdRef, change: &ChangeSnapshot, workspace: Option<&Path>) -> Self {
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
                Segment::tagged(parent.to_string(), Tag::ChangeId).leading_to(Target::Change { change: parent.clone() })
            }),
        ));
        let revision = |revision: &RevisionId| Segment::tagged(revision.to_string(), Tag::Revision);
        lines.push(list("Tip:", std::iter::once(revision(&change.tip))));
        lines.push(list("Bases:", change.bases.iter().map(revision)));
        lines.push(list("Workspace:", workspace.map(|path| Segment::plain(path.display().to_string())).into_iter()));
        Self { lines, folds: Vec::new() }
    }

    /// The files `change`'s `view` diffs, headed by the change's name, which links to the first
    /// file listed so that diffs can be read in order from the top; below, each file leads to its
    /// own diff and each folder to all under it.
    pub fn files(change: &ChangeIdRef, title: Option<&str>, view: View, files: &[ChangedFile]) -> Self {
        let kind = match view {
            View::Diff => "changed",
            View::Review => "unreviewed",
            View::Workspace => "uncommitted",
        };
        let target = |files: &[&ChangedFile]| Target::Diff {
            view,
            change: change.to_owned(),
            files: files.iter().map(|&file| file.clone()).collect(),
        };
        let tree = FileTree::new(files);
        let first = tree.listed_files().first().map(|&first| target(&[first]));
        // Linked from its text rather than led to by the line, as selections gather the files of
        // lines and the heading is not one.
        let heading = [
            Segment::tagged(name(change, title), Tag::Heading),
            Segment::tagged(format!(" · {kind} files"), Tag::Muted),
        ]
        .into_iter()
        .map(|segment| Segment { target: first.clone(), ..segment })
        .collect();
        let mut page =
            Self { lines: vec![Line { segments: heading, target: None }, Line::default()], folds: Vec::new() };
        page.append(match files.is_empty() {
            true => Self::message(format!("no {kind} files")),
            false => tree.render_with_targets(|files| Some(target(files))),
        });
        page
    }

    /// The tail of a show page: one line per Claude Code session that worked on `change`, each
    /// leading to itself, folding under their label. Sessions are listed as given, so callers
    /// order them.
    pub fn sessions(change: &ChangeIdRef, sessions: &[Session], now: TimestampMs) -> Self {
        if sessions.is_empty() {
            return Self { lines: vec![Line::default(), list("Sessions:", std::iter::empty())], folds: Vec::new() };
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
        Self { lines, folds: vec![Fold { start: 1, end }] }
    }

    /// A page of one muted line, for when there is nothing to show.
    pub fn message(text: impl Into<String>) -> Self {
        Self { lines: vec![Line::default().push(Segment::tagged(text, Tag::Muted))], folds: Vec::new() }
    }

    /// Continue with `other`'s lines, its folds moved down to them.
    pub fn append(&mut self, other: Self) {
        let offset = u32::try_from(self.lines.len()).expect("pages are short");
        self.lines.extend(other.lines);
        self.folds
            .extend(other.folds.into_iter().map(|fold| Fold { start: fold.start + offset, end: fold.end + offset }));
    }
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
