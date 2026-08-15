use std::collections::{BTreeMap, BTreeSet};

use crate::{error::Result, home::HomeGraph, types::ChangeId};

// TODO(jm): audit LLM

/// Renders a home graph as rail art: one row per change, x-position = depth in the stack.
///
/// `○` marks the viewer's changes, `◌` unowned ancestors shown as context. Trunk is never drawn:
/// a change whose parents have all landed is a root. Connected components render one after
/// another; each starts with a root on the left margin.
pub fn render_home(graph: &HomeGraph) -> Result<String> {
    let depths = depths(graph)?;
    let blocks: Vec<String> =
        components(graph).iter().map(|component| draw(graph, component, &depths)).collect::<Result<_>>()?;
    Ok(blocks.concat())
}

/// Depth is the longest parent chain below a change; roots sit at depth 0.
fn depths(graph: &HomeGraph) -> Result<BTreeMap<&ChangeId, usize>> {
    fn visit<'a>(
        graph: &'a HomeGraph,
        id: &'a ChangeId,
        memo: &mut BTreeMap<&'a ChangeId, Option<usize>>,
    ) -> Result<usize> {
        if let Some(state) = memo.get(id) {
            return match state {
                Some(depth) => Ok(*depth),
                None => Err(format!("parent cycle involving {id}").into()),
            };
        }
        memo.insert(id, None);
        let mut depth = 0;
        for parent in &graph.nodes[id].parents {
            depth = depth.max(visit(graph, parent, memo)? + 1);
        }
        memo.insert(id, Some(depth));
        Ok(depth)
    }

    let mut memo = BTreeMap::new();
    for id in graph.nodes.keys() {
        visit(graph, id, &mut memo)?;
    }
    Ok(memo.into_iter().map(|(id, depth)| (id, depth.expect("every visit completed"))).collect())
}

/// Changes grouped by connectivity over parent edges, ordered by smallest id.
fn components(graph: &HomeGraph) -> Vec<Vec<&ChangeId>> {
    let mut neighbors: BTreeMap<&ChangeId, Vec<&ChangeId>> = BTreeMap::new();
    for (id, node) in &graph.nodes {
        neighbors.entry(id).or_default();
        for parent in &node.parents {
            neighbors.entry(id).or_default().push(parent);
            neighbors.entry(parent).or_default().push(id);
        }
    }

    let mut all = Vec::new();
    let mut seen = BTreeSet::new();
    for start in graph.nodes.keys() {
        if !seen.insert(start) {
            continue;
        }
        let mut component = vec![start];
        let mut frontier = vec![start];
        while let Some(id) = frontier.pop() {
            for &next in &neighbors[id] {
                if seen.insert(next) {
                    component.push(next);
                    frontier.push(next);
                }
            }
        }
        component.sort();
        all.push(component);
    }
    all
}

/// Parents-before-children order, following each stack depth-first so linear runs stay
/// contiguous. Siblings order by id.
fn order_rows<'a>(graph: &'a HomeGraph, component: &[&'a ChangeId]) -> Vec<&'a ChangeId> {
    let mut children: BTreeMap<&ChangeId, Vec<&ChangeId>> = BTreeMap::new();
    let mut pending: BTreeMap<&ChangeId, usize> = BTreeMap::new();
    for &id in component {
        let node = &graph.nodes[id];
        pending.insert(id, node.parents.len());
        for parent in &node.parents {
            children.entry(parent).or_default().push(id);
        }
    }

    let mut rows = Vec::new();
    let mut stack: Vec<&ChangeId> =
        pending.iter().filter(|&(_, &parents)| parents == 0).map(|(&id, _)| id).rev().collect();
    while let Some(id) = stack.pop() {
        rows.push(id);
        let mut ready = Vec::new();
        for &child in children.get(id).into_iter().flatten() {
            let parents = pending.get_mut(child).expect("children are in the component");
            *parents -= 1;
            if *parents == 0 {
                ready.push(child);
            }
        }
        stack.extend(ready.iter().rev());
    }
    assert_eq!(rows.len(), component.len(), "an acyclic component orders fully");
    rows
}

fn draw(graph: &HomeGraph, component: &[&ChangeId], depths: &BTreeMap<&ChangeId, usize>) -> Result<String> {
    /// Labels sit a fixed gutter right of their node, leaving room for future status glyphs and
    /// stepping with depth; rails wider than the gutter push them aside.
    const LABEL_GUTTER: usize = 4;

    let rows = order_rows(graph, component);
    let row_of: BTreeMap<&ChangeId, usize> = rows.iter().enumerate().map(|(r, &id)| (id, r)).collect();
    let cols: Vec<usize> = rows.iter().map(|&id| 2 * depths[id]).collect();

    let mut drawer = Drawer::new(rows.len());
    for (r, &id) in rows.iter().enumerate() {
        drawer.grid.set(r, cols[r], if graph.nodes[id].owned { '○' } else { '◌' });
    }
    for (r, &id) in rows.iter().enumerate() {
        let mut parents: Vec<usize> = graph.nodes[id].parents.iter().map(|parent| row_of[parent]).collect();
        parents.sort_unstable();
        for rp in parents {
            if !drawer.edge(rp, cols[rp], r, cols[r]) {
                return Err(format!("could not route a parent edge into {id}").into());
            }
        }
    }

    let mut lines = Vec::new();
    for (r, &id) in rows.iter().enumerate() {
        let art: String = drawer.grid.cells[r].iter().collect();
        let art = art.trim_end();
        let start = (cols[r] + LABEL_GUTTER).max(art.chars().count() + 2);
        let mut line = format!("{art:<start$}{id}");
        if let Some(title) = &graph.nodes[id].title {
            line.push_str("  ");
            line.push_str(title);
        }
        lines.push(line);
    }
    let mut block = lines.join("\n");
    block.push('\n');
    Ok(block)
}

struct Grid {
    cells: Vec<Vec<char>>,
}

impl Grid {
    fn get(&self, row: usize, col: usize) -> char { self.cells[row].get(col).copied().unwrap_or(' ') }

    fn set(&mut self, row: usize, col: usize, glyph: char) {
        let row = &mut self.cells[row];
        if row.len() <= col {
            row.resize(col + 1, ' ');
        }
        row[col] = glyph;
    }

    fn width(&self) -> usize { self.cells.iter().map(Vec::len).max().unwrap_or(0) }
}

type Writes = Vec<(usize, usize, char)>;

struct Drawer {
    grid: Grid,
    /// Lowest row each parent's own-column rail has reached, keyed by the parent's row.
    rail_bottom: BTreeMap<usize, usize>,
    /// Lanes descending into each child as (birth row, column), keyed by the child's row.
    lanes: BTreeMap<usize, Vec<(usize, usize)>>,
}

impl Drawer {
    fn new(rows: usize) -> Self {
        Self { grid: Grid { cells: vec![Vec::new(); rows] }, rail_bottom: BTreeMap::new(), lanes: BTreeMap::new() }
    }

    /// Draws the edge (rp, cp) → (rc, cc), preferring in order: a rail down the parent's own
    /// column, a lane dropping straight into the child's column, joining an existing lane into
    /// the same child, then any routable free column right of the parent, then left.
    fn edge(&mut self, rp: usize, cp: usize, rc: usize, cc: usize) -> bool {
        assert!(rp < rc && cp < cc, "edges point down and right");
        if self.rail(rp, cp, rc, cc) || self.lane(rp, cp, rc, cc, cc) || self.join(rp, cp, rc) {
            return true;
        }
        let mut col = cp + 1;
        let limit = self.grid.width().max(cc) + 2;
        while col <= limit {
            if col != cc && self.lane(rp, cp, rc, cc, col) {
                return true;
            }
            if !passable(self.grid.get(rp, col)) {
                break;
            }
            col += 1;
        }
        let mut col = cp;
        while col > 0 {
            col -= 1;
            if self.lane(rp, cp, rc, cc, col) {
                return true;
            }
            if !passable(self.grid.get(rp, col)) {
                break;
            }
        }
        false
    }

    /// A rail down the parent's own column, elbowing right into the child: the file-tree shape.
    fn rail(&mut self, rp: usize, cp: usize, rc: usize, cc: usize) -> bool {
        let owned_until = self.rail_bottom.get(&rp).copied().unwrap_or(rp);
        let mut writes = Vec::new();
        for row in rp + 1..rc {
            let current = self.grid.get(row, cp);
            let next = if row <= owned_until {
                // Extending our own rail past earlier children and foreign crossings.
                match current {
                    '│' | '├' | '┼' => current,
                    '╰' => '├',
                    _ => return false,
                }
            } else {
                match current {
                    ' ' => '│',
                    '─' => '┼',
                    _ => return false,
                }
            };
            writes.push((row, cp, next));
        }
        let elbow = match self.grid.get(rc, cp) {
            ' ' => '╰',
            '─' => '┴',
            _ => return false,
        };
        writes.push((rc, cp, elbow));
        let Some(run) = self.horizontal(rc, cp, cc, true) else { return false };
        writes.extend(run);
        self.apply(writes);
        self.rail_bottom.insert(rp, rc);
        true
    }

    /// A lane born on the parent's row descending column `col`, entering the child vertically
    /// (`col == cc`) or elbowing into it along the child's row.
    fn lane(&mut self, rp: usize, cp: usize, rc: usize, cc: usize, col: usize) -> bool {
        if col == cp {
            return false;
        }
        let birth = match self.grid.get(rp, col) {
            ' ' if col > cp => '╮',
            ' ' => '╭',
            '─' => '┬',
            _ => return false,
        };
        let mut writes = vec![(rp, col, birth)];
        let Some(run) = self.horizontal(rp, cp, col, false) else { return false };
        writes.extend(run);
        for row in rp + 1..rc {
            let next = match self.grid.get(row, col) {
                ' ' => '│',
                '─' => '┼',
                _ => return false,
            };
            writes.push((row, col, next));
        }
        if col != cc {
            let arrival = match self.grid.get(rc, col) {
                ' ' if col > cc => '╯',
                ' ' => '╰',
                '─' => '┴',
                _ => return false,
            };
            writes.push((rc, col, arrival));
            let Some(run) = self.horizontal(rc, col, cc, true) else { return false };
            writes.extend(run);
        }
        self.apply(writes);
        self.lanes.entry(rc).or_default().push((rp, col));
        true
    }

    /// Merge into an existing lane already descending into the same child. The lane must have
    /// been born above the joining row: a `│` in its column could otherwise be a stranger.
    fn join(&mut self, rp: usize, cp: usize, rc: usize) -> bool {
        for (born, col) in self.lanes.get(&rc).cloned().unwrap_or_default() {
            if born >= rp || col == cp || self.grid.get(rp, col) != '│' {
                continue;
            }
            let Some(run) = self.horizontal(rp, cp, col, false) else { continue };
            let mut writes = run;
            writes.push((rp, col, if col > cp { '┤' } else { '├' }));
            self.apply(writes);
            return true;
        }
        false
    }

    /// A horizontal run across the cells strictly between two columns. On a child's row every
    /// segment feeds the same node, so meeting another incoming rail merges (`╰` → `┴`); on a
    /// parent's row runs may extend past the parent's own earlier births (`╮` → `┬`).
    fn horizontal(&self, row: usize, a: usize, b: usize, into_child: bool) -> Option<Writes> {
        let mut writes = Vec::new();
        for col in a.min(b) + 1..a.max(b) {
            let next = match self.grid.get(row, col) {
                ' ' | '─' => '─',
                '│' | '┼' => '┼',
                '╮' | '┬' if !into_child => '┬',
                '╰' | '┴' if into_child => '┴',
                _ => return None,
            };
            writes.push((row, col, next));
        }
        Some(writes)
    }

    fn apply(&mut self, writes: Writes) {
        for (row, col, glyph) in writes {
            self.grid.set(row, col, glyph);
        }
    }
}

/// Whether the free-column scan may continue past this cell on the parent's row.
fn passable(cell: char) -> bool { matches!(cell, ' ' | '─' | '│' | '┼' | '╮' | '┬') }
