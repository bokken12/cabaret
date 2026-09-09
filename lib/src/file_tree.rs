//! Compact file trees with the same branch markers as the home graph.

use std::collections::BTreeMap;

use crate::{Fold, Line, Page, RepoPath, Segment, Tag};

/// A diff can delete a file and add a directory at the same path, so a node may hold both.
pub struct FileTree<'a, T> {
    files: Vec<&'a T>,
    children: BTreeMap<&'a str, Self>,
}

impl<T> Default for FileTree<'_, T> {
    fn default() -> Self { Self { files: Vec::new(), children: BTreeMap::new() } }
}

impl<'a, T> FileTree<'a, T> {
    pub fn insert(&mut self, path: &'a RepoPath, value: &'a T) {
        let mut node = self;
        for component in path.as_ref().split('/') {
            node = node.children.entry(component).or_default();
        }
        node.files.push(value);
    }

    /// Render compact paths with folder folds; the caller supplies each file's styling and target.
    pub fn render(&self, row: impl Fn(&T, &str) -> Line) -> Page {
        let mut page = Page::default();
        self.render_into(&mut page, None, &row);
        page.folds.sort_by_key(|fold| fold.start);
        page
    }

    /// Match the home graph: files are nodes, folders are context, and roots start at the margin.
    fn render_into(&self, page: &mut Page, prefix: Option<&str>, row: &impl Fn(&T, &str) -> Line) {
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
                let mut line = row(file, &name);
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
                child.render_into(page, Some(&continuation), row);
                let end = u32::try_from(page.lines.len() - 1).expect("pages are short");
                page.folds.push(Fold { start, end });
            }
        }
    }
}
