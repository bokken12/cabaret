//! Pages are what frontends display: lines of text cut into tagged segments, where a segment or
//! a whole line may name where it leads. Frontends paint tags in their own style and follow the
//! target under the cursor.
// TODO-someday(joel): move page and UI details to a separate crate?

use std::{fmt, path::Path};

use cabaret_types::{ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Revision};

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
    Change { change: ChangeId },
    Diff { change: ChangeId, file: ChangedFile },
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
        let mut lines = vec![heading];
        if let Some(description) = &change.description {
            lines.push(Line::default());
            lines.extend(description.lines().map(Line::plain));
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
        let revision = |revision: &Revision| Segment::tagged(revision.to_string(), Tag::Revision);
        lines.push(list("Tip:", std::iter::once(revision(&change.tip))));
        lines.push(list("Bases:", change.bases.iter().map(revision)));
        lines.push(list("Workspace:", workspace.map(|path| Segment::plain(path.display().to_string())).into_iter()));
        Self { lines, folds: Vec::new() }
    }

    pub fn diff(change: &ChangeIdRef, files: &[ChangedFile]) -> Self {
        if files.is_empty() {
            return Self::message("no changed files");
        }
        let row = |file: &ChangedFile| {
            let (text, tag) = match file {
                ChangedFile::Added { path } => (path.to_string(), Tag::Added),
                ChangedFile::Deleted { path } => (path.to_string(), Tag::Deleted),
                ChangedFile::Modified { path } => (path.to_string(), Tag::Modified),
                ChangedFile::Renamed { from, path } => (format!("{from} -> {path}"), Tag::Renamed),
                ChangedFile::Copied { from, path } => (format!("{from} => {path}"), Tag::Copied),
            };
            let target = Target::Diff { change: change.to_owned(), file: file.clone() };
            Line::default().push(Segment::tagged(text, tag)).leading_to(target)
        };
        Self { lines: files.iter().map(row).collect(), folds: Vec::new() }
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
