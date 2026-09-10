mod file_tree;
mod home;
mod page;

/// Bracket folds in the margin: `╭` on the folding row, `│` on hidden rows, `╰` on the last.
/// Nested folds occupy successive columns; `text` may be plain or tagged page markup.
fn with_folds(page: &cabaret_lib::Page, text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut margin = vec![Vec::<char>::new(); lines.len()];
    let mut active: Vec<u32> = Vec::new();
    for fold in &page.folds {
        while active.last().is_some_and(|&end| end < fold.start) {
            active.pop();
        }
        let col = active.len();
        active.push(fold.end);
        let (start, end) = (usize::try_from(fold.start).unwrap(), usize::try_from(fold.end).unwrap());
        for (r, row) in margin.iter_mut().enumerate().take(end + 1).skip(start) {
            if row.len() <= col {
                row.resize(col + 1, ' ');
            }
            row[col] = match r {
                _ if r == start => '╭',
                _ if r == end => '╰',
                _ => '│',
            };
        }
    }
    // A foldless page keeps no margin: a uniform one would not survive expect's dedent anyway.
    let width = margin.iter().map(Vec::len).max().unwrap_or(0);
    lines
        .iter()
        .zip(&margin)
        .map(|(line, cells)| {
            let cells: String = cells.iter().collect();
            if width == 0 { format!("{line}\n") } else { format!("{cells:<width$}  {line}\n") }
        })
        .collect()
}
