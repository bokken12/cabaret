use std::fmt::Write as _;

use gix::diff::blob::{
    Algorithm, InternedInput, UnifiedDiff,
    unified_diff::{ConsumeHunk, ContextSize, DiffLineKind, HunkHeader},
};

use crate::{
    base::Base,
    cabaret::Cabaret,
    diff::{ChangedFile, Diff, FileVersion, Source},
    error::Result,
};

/// ANSI styling, or plain text when disabled.
struct Paint(bool);

impl Paint {
    fn wrap(&self, code: &str, text: &str) -> String {
        if self.0 { format!("\x1b[{code}m{text}\x1b[0m") } else { text.to_owned() }
    }

    fn bold(&self, text: &str) -> String { self.wrap("1", text) }
    fn red(&self, text: &str) -> String { self.wrap("31", text) }
    fn green(&self, text: &str) -> String { self.wrap("32", text) }
    fn yellow(&self, text: &str) -> String { self.wrap("33", text) }
    fn cyan(&self, text: &str) -> String { self.wrap("36", text) }
}

impl Cabaret {
    /// Render `diff` as per-file unified hunks.
    pub fn render_diff(&self, diff: &Diff, color: bool) -> Result<String> {
        let paint = Paint(color);
        let mut out = String::new();
        if let Base::Synthetic { conflicts, .. } = &diff.base
            && !conflicts.is_empty()
        {
            writeln!(out, "{}", paint.yellow(&format!("synthetic base conflicts: {}", conflicts.join(", "))))?;
        }
        for (index, file) in diff.files.iter().enumerate() {
            if index > 0 || !out.is_empty() {
                out.push('\n');
            }
            writeln!(out, "{}", paint.bold(&label(file)))?;
            self.render_file(file, &paint, &mut out)?;
        }
        Ok(out)
    }

    fn render_file(&self, file: &ChangedFile, paint: &Paint, out: &mut String) -> Result<()> {
        if [&file.base, &file.tip].iter().any(|version| version.is_some_and(|v| v.mode.is_commit())) {
            writeln!(out, "submodule changed")?;
            return Ok(());
        }
        let before = self.contents(file.base)?;
        let after = self.contents(file.tip)?;
        if binary(&before) || binary(&after) {
            writeln!(out, "binary files differ")?;
            return Ok(());
        }
        let input = InternedInput::new(before.as_slice(), after.as_slice());
        let mut diff = gix::diff::blob::Diff::compute(Algorithm::Histogram, &input);
        diff.postprocess_lines(&input);
        UnifiedDiff::new(&diff, &input, Hunks { out, paint }, ContextSize::default()).consume()?;
        Ok(())
    }

    fn contents(&self, version: Option<FileVersion>) -> Result<Vec<u8>> {
        match version {
            None => Ok(Vec::new()),
            Some(version) => Ok(self.repo.find_object(version.id)?.detach().data),
        }
    }
}

fn label(file: &ChangedFile) -> String {
    let path = match &file.source {
        Some(Source { path: source, copied: false }) => format!("{source} => {}", file.path),
        Some(Source { path: source, copied: true }) => format!("{source} => {} (copied)", file.path),
        None => file.path.clone(),
    };
    match (&file.base, &file.tip) {
        (None, Some(_)) => format!("{path} (added)"),
        (Some(_), None) => format!("{path} (deleted)"),
        _ => path,
    }
}

fn binary(data: &[u8]) -> bool { data[..data.len().min(8192)].contains(&0) }

struct Hunks<'a> {
    out: &'a mut String,
    paint: &'a Paint,
}

impl ConsumeHunk for Hunks<'_> {
    type Out = ();

    fn consume_hunk(&mut self, header: HunkHeader, lines: &[(DiffLineKind, &[u8])]) -> std::io::Result<()> {
        let range = |start: u32, len: u32| if len == 1 { format!("{start}") } else { format!("{start},{len}") };
        let header = format!(
            "@@ -{} +{} @@",
            range(header.before_hunk_start, header.before_hunk_len),
            range(header.after_hunk_start, header.after_hunk_len),
        );
        self.out.push_str(&self.paint.cyan(&header));
        self.out.push('\n');
        for &(kind, line) in lines {
            let text = String::from_utf8_lossy(line);
            let text = text.strip_suffix('\n').unwrap_or(&text);
            let line = match kind {
                DiffLineKind::Context => format!(" {text}"),
                DiffLineKind::Add => self.paint.green(&format!("+{text}")),
                DiffLineKind::Remove => self.paint.red(&format!("-{text}")),
            };
            self.out.push_str(&line);
            self.out.push('\n');
        }
        Ok(())
    }

    fn finish(self) -> Self::Out {}
}
