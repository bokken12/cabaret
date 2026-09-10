//! Compact file trees with the same branch markers as the home graph.

use std::collections::BTreeMap;

use crate::{ChangedFile, Fold, Line, Page, Segment, Tag, Target};

/// A diff can delete a file and add a directory at the same path, so a node may hold both.
#[derive(Default)]
pub struct FileTree<'a> {
    files: Vec<&'a ChangedFile>,
    children: BTreeMap<&'a str, Self>,
}

impl<'a> FileTree<'a> {
    pub fn new(files: &'a [ChangedFile]) -> Self {
        let mut tree = Self::default();
        for file in files {
            let mut node = &mut tree;
            for component in file.path().as_ref().split('/') {
                node = node.children.entry(component).or_default();
            }
            node.files.push(file);
        }
        tree
    }

    /// Render changed-file labels and folder folds without Cabaret change navigation.
    pub fn render(&self) -> Page { self.render_with_targets(|_| None) }

    pub(crate) fn render_with_targets(&self, target: impl Fn(&ChangedFile) -> Option<Target>) -> Page {
        let mut page = Page::default();
        self.render_into(&mut page, None, &target);
        page.folds.sort_by_key(|fold| fold.start);
        page
    }

    /// Match the home graph: files are nodes, folders are context, and roots start at the margin.
    fn render_into(&self, page: &mut Page, prefix: Option<&str>, target: &impl Fn(&ChangedFile) -> Option<Target>) {
        for (index, (name, child)) in self.children.iter().enumerate() {
            let mut name = (*name).to_owned();
            let mut child = child;
            // Only branching directories need a separate row, including along the path to a lone file.
            while child.files.is_empty() && child.children.len() == 1 {
                let (next, node) = child.children.first_key_value().expect("one child");
                name.push('/');
                name.push_str(next);
                child = node;
            }
            let last = index + 1 == self.children.len();
            let art = |last: bool, marker: char| match prefix {
                None => format!("{marker} "),
                Some(prefix) => format!("{prefix}{}{marker} ", if last { "╰─" } else { "├─" }),
            };
            for (index, file) in child.files.iter().enumerate() {
                let last_file = last && child.children.is_empty() && index + 1 == child.files.len();
                let mut line = file_row(file, &name);
                line.target = target(file);
                line.segments.insert(0, Segment::plain(art(last_file, '○')));
                page.lines.push(line);
            }
            if !child.children.is_empty() {
                let start = u32::try_from(page.lines.len()).expect("pages are short");
                page.lines.push(Line::plain(art(last, '◌')).push(Segment::tagged(format!("{name}/"), Tag::Label)));
                let continuation = match prefix {
                    None => String::new(),
                    Some(prefix) => format!("{prefix}{}", if last { "  " } else { "│ " }),
                };
                child.render_into(page, Some(&continuation), target);
                let end = u32::try_from(page.lines.len() - 1).expect("pages are short");
                page.folds.push(Fold { start, end });
            }
        }
    }
}

fn file_row(file: &ChangedFile, name: &str) -> Line {
    let (tag, source) = match file {
        ChangedFile::Added { .. } => (Tag::Added, None),
        ChangedFile::Deleted { .. } => (Tag::Deleted, None),
        ChangedFile::Modified { .. } => (Tag::Modified, None),
        ChangedFile::Renamed { from, .. } => (Tag::Renamed, Some(("moved", from))),
        ChangedFile::Copied { from, .. } => (Tag::Copied, Some(("copied", from))),
    };
    let mut row = Line::default().push(Segment::tagged(name, tag));
    if let Some((verb, from)) = source {
        let (from_dir, from_name) = from.as_ref().rsplit_once('/').unwrap_or(("", from.as_ref()));
        let (to_dir, _) = file.path().as_ref().rsplit_once('/').unwrap_or(("", file.path().as_ref()));
        let source = if from_dir == to_dir { from_name } else { from.as_ref() };
        row = row.push(Segment::tagged(format!(" ← {verb} from {source}"), Tag::Muted));
    }
    row
}
