//! Pages are what frontends display: lines of text cut into tagged segments, where a segment or
//! a whole line may name where it leads. Frontends paint tags in their own style and follow the
//! target under the cursor.
// TODO-someday(joel): move page and UI details to a separate crate?

use std::{collections::BTreeMap, fmt, path::Path};

use cabaret_agents::{Session, SessionId, Status};
use cabaret_types::{ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, RevisionId, TimestampMs};

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

/// Where a piece of text leads.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(discriminant = "kind"))]
pub enum Target {
    Change {
        change: ChangeId,
    },
    /// A file of `change`'s diff: from its base to its tip.
    Diff {
        change: ChangeId,
        file: ChangedFile,
    },
    /// A file of `change`'s workspace diff: from its tip to what its workspace has on disk.
    WorkspaceDiff {
        change: ChangeId,
        file: ChangedFile,
    },
    /// A file of `change`'s review diff: from the merge of its bases with the tip the reviewer
    /// last marked the file reviewed at, to its tip.
    ReviewDiff {
        change: ChangeId,
        file: ChangedFile,
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
    /// `workspace` is the working directory of the workspace holding the change, if any.
    pub fn show(id: &ChangeIdRef, change: &ChangeSnapshot, workspace: Option<&Path>) -> Self {
        let mut heading = Line::default().push(Segment::tagged(id.to_string(), Tag::Heading));
        if let Some(title) = &change.title {
            heading = heading.push(Segment::plain(" — ")).push(Segment::tagged(title, Tag::Heading));
        }
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

    /// The files `change` presents against its base, each leading to its diff.
    pub fn diff(change: &ChangeIdRef, files: &[ChangedFile]) -> Self {
        Self::files(files, "no changed files", |file| Target::Diff { change: change.to_owned(), file })
    }

    /// The files `change`'s workspace has on disk beyond its tip, each leading to its diff.
    pub fn workspace(change: &ChangeIdRef, files: &[ChangedFile]) -> Self {
        Self::files(files, "no uncommitted files", |file| Target::WorkspaceDiff { change: change.to_owned(), file })
    }

    /// The files of `change` its reviewer has left to read, each leading to its review diff.
    pub fn review(change: &ChangeIdRef, files: &[ChangedFile]) -> Self {
        Self::files(files, "no unreviewed files", |file| Target::ReviewDiff { change: change.to_owned(), file })
    }

    fn files(files: &[ChangedFile], empty: &str, target: impl Fn(ChangedFile) -> Target) -> Self {
        if files.is_empty() {
            return Self::message(empty);
        }
        let mut tree = FileTree::default();
        for file in files {
            let mut node = &mut tree;
            for component in file.path().as_ref().split('/') {
                node = node.children.entry(component).or_default();
            }
            node.files.push(file);
        }
        let mut page = Self::default();
        tree.render(&mut page, 0, &target);
        page.folds.sort_by_key(|fold| fold.start);
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

/// A diff can delete a file and add a directory at the same path, so a node may hold both.
#[derive(Default)]
struct FileTree<'a> {
    files: Vec<&'a ChangedFile>,
    children: BTreeMap<&'a str, Self>,
}

impl FileTree<'_> {
    fn render(&self, page: &mut Page, depth: usize, target: &impl Fn(ChangedFile) -> Target) {
        for (name, child) in &self.children {
            let mut name = (*name).to_owned();
            let mut child = child;
            // Only branching directories need a separate row, including along the path to a lone file.
            while child.files.is_empty() && child.children.len() == 1 {
                let (next, node) = child.children.first_key_value().expect("one child");
                name.push('/');
                name.push_str(next);
                child = node;
            }
            let indent = "  ".repeat(depth);
            for file in &child.files {
                let (tag, source) = match file {
                    ChangedFile::Added { .. } => (Tag::Added, None),
                    ChangedFile::Deleted { .. } => (Tag::Deleted, None),
                    ChangedFile::Modified { .. } => (Tag::Modified, None),
                    ChangedFile::Renamed { from, .. } => (Tag::Renamed, Some(("moved", from))),
                    ChangedFile::Copied { from, .. } => (Tag::Copied, Some(("copied", from))),
                };
                let mut row = Line::plain(&indent).push(Segment::tagged(&name, tag));
                if let Some((verb, from)) = source {
                    let (from_dir, from_name) = from.as_ref().rsplit_once('/').unwrap_or(("", from.as_ref()));
                    let (to_dir, _) = file.path().as_ref().rsplit_once('/').unwrap_or(("", file.path().as_ref()));
                    let source = if from_dir == to_dir { from_name } else { from.as_ref() };
                    row = row.push(Segment::tagged(format!(" ← {verb} from {source}"), Tag::Muted));
                }
                page.lines.push(row.leading_to(target((*file).clone())));
            }
            if !child.children.is_empty() {
                let start = u32::try_from(page.lines.len()).expect("pages are short");
                page.lines.push(Line::plain(&indent).push(Segment::tagged(format!("{name}/"), Tag::Label)));
                child.render(page, depth + 1, target);
                let end = u32::try_from(page.lines.len() - 1).expect("pages are short");
                page.folds.push(Fold { start, end });
            }
        }
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
