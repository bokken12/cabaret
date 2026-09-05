//! The home page: the viewer's open changes, then those checked out on this device, each with
//! their ancestors, drawn as rail art with one row per change and x-position for depth in the
//! stack.

use std::collections::{BTreeMap, BTreeSet};

use cabaret_types::{ChangeId, Identity, Result};

use crate::page::{Fold, Line, Page, Segment, Tag, Target};

/// A change in a home graph: one the graph is about, or an open ancestor shown as context.
pub struct HomeNode {
    pub title: Option<String>,
    pub selected: bool,
    /// Parents that are themselves nodes of the same graph.
    pub parents: BTreeSet<ChangeId>,
}

/// A selection of changes and their ancestors, closed under `parents`.
pub struct HomeGraph {
    pub nodes: BTreeMap<ChangeId, HomeNode>,
}

/// What one viewer sees on this device: the changes they own, and the changes checked out in
/// its workspaces.
pub struct Home {
    pub viewer: Identity,
    pub owned: HomeGraph,
    pub workspaces: HomeGraph,
}

/// Labels sit a fixed gutter right of their node, leaving room for status glyphs and stepping
/// with depth; rails wider than the gutter push them aside.
const LABEL_GUTTER: usize = 4;

impl Page {
    /// Each graph under a heading, with a muted line where one is empty.
    pub fn home(home: &Home) -> Result<Self> {
        let section = |page: &mut Self, heading: &str, graph: &HomeGraph, empty: String| -> Result<()> {
            page.lines.push(Line::default().push(Segment::tagged(heading, Tag::Heading)));
            page.append(if graph.nodes.is_empty() { Self::message(empty) } else { Self::graph(graph)? });
            Ok(())
        };
        let mut page = Self::default();
        section(&mut page, "Owned", &home.owned, format!("no open changes owned by {}", home.viewer))?;
        page.lines.push(Line::default());
        section(&mut page, "Workspaces", &home.workspaces, "no changes checked out in a workspace".into())?;
        Ok(page)
    }

    /// `○` marks the selected changes, `◌` ancestors shown as context, and `»` a label that
    /// plumbing pushed right of its depth position. Titles sit in a column right of every label.
    /// Connected components render one after another, each starting with a root on the left
    /// margin; every row leads to its change, and a change whose stack sits directly below it
    /// folds that stack away.
    pub fn graph(graph: &HomeGraph) -> Result<Self> {
        let depths = depths(graph)?;
        let mut rows = Vec::new();
        for component in components(graph) {
            rows.extend(draw(graph, &component, &depths)?);
        }

        let width = |row: &Row| row.art.chars().count() + row.id.to_string().chars().count();
        let title_start = rows.iter().map(width).max().expect("a non-empty graph has rows") + 2;
        let lines = rows
            .iter()
            .map(|row| {
                let node = &graph.nodes[row.id];
                let mut line = Line::default().push(Segment::plain(&row.art));
                if row.pushed {
                    line = line.push(Segment::tagged("»", Tag::Muted));
                }
                let tag = if node.selected { Tag::ChangeId } else { Tag::Muted };
                line = line.push(Segment::tagged(row.id.to_string(), tag));
                if let Some(title) = &node.title {
                    line = line.push(Segment::plain(" ".repeat(title_start - width(row))));
                    line = line.push(if node.selected {
                        Segment::plain(title)
                    } else {
                        Segment::tagged(title, Tag::Muted)
                    });
                }
                line.leading_to(Target::Change { change: row.id.clone() })
            })
            .collect();
        Ok(Self { lines, folds: folds(graph, &rows) })
    }
}

/// A change folds exactly when its descendants sit contiguously after its own row and connect
/// to the graph only through it, hiding that block. Scattered descendants (which no single run
/// of lines could hide) and descendants shared with a change outside the block (which would
/// stay visible while its child vanished) leave it unfoldable. Such blocks nest or stay
/// disjoint: a block starting inside another belongs to a descendant, whose own descendants
/// the outer block already spans.
fn folds(graph: &HomeGraph, rows: &[Row]) -> Vec<Fold> {
    let row_of: BTreeMap<&ChangeId, usize> = rows.iter().enumerate().map(|(r, row)| (row.id, r)).collect();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); rows.len()];
    for (r, row) in rows.iter().enumerate() {
        for parent in &graph.nodes[row.id].parents {
            children[row_of[parent]].push(r);
        }
    }

    let mut folds = Vec::new();
    for start in 0..rows.len() {
        let mut descendant = vec![false; rows.len()];
        let mut frontier = children[start].clone();
        let mut count = 0;
        while let Some(r) = frontier.pop() {
            if !descendant[r] {
                descendant[r] = true;
                count += 1;
                frontier.extend(&children[r]);
            }
        }
        let end = start + count;
        let contiguous = count > 0 && (start + 1..=end).all(|r| descendant[r]);
        let only_through_start = |r: usize| {
            graph.nodes[rows[r].id].parents.iter().all(|parent| {
                let parent = row_of[parent];
                parent == start || descendant[parent]
            })
        };
        if contiguous && (start + 1..=end).all(only_through_start) {
            let line = |r: usize| u32::try_from(r).expect("a home page is short");
            folds.push(Fold { start: line(start), end: line(end) });
        }
    }
    folds
}

/// One drawn row: the rail art, padded so the id follows it directly, and whether plumbing
/// pushed the id off its depth position (drawn as `»` in the last column of `art`'s padding).
struct Row<'a> {
    art: String,
    pushed: bool,
    id: &'a ChangeId,
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

fn draw<'a>(
    graph: &'a HomeGraph,
    component: &[&'a ChangeId],
    depths: &BTreeMap<&ChangeId, usize>,
) -> Result<Vec<Row<'a>>> {
    let rows = order_rows(graph, component);
    let row_of: BTreeMap<&ChangeId, usize> = rows.iter().enumerate().map(|(r, &id)| (id, r)).collect();
    let cols: Vec<usize> = rows.iter().map(|&id| 2 * depths[id]).collect();

    let mut drawer = Drawer::new(rows.len());
    for (r, &id) in rows.iter().enumerate() {
        drawer.grid.set(r, cols[r], if graph.nodes[id].selected { '○' } else { '◌' });
    }
    let mut last_child_row: BTreeMap<usize, usize> = BTreeMap::new();
    for (r, &id) in rows.iter().enumerate() {
        for parent in &graph.nodes[id].parents {
            last_child_row.insert(row_of[parent], r);
        }
    }
    for (r, &id) in rows.iter().enumerate() {
        let mut parents: Vec<usize> = graph.nodes[id].parents.iter().map(|parent| row_of[parent]).collect();
        parents.sort_unstable();
        for rp in parents {
            if !drawer.edge(rp, cols[rp], r, cols[r], last_child_row[&rp] == r) {
                return Err(format!("could not route a parent edge into {id}").into());
            }
        }
    }

    Ok(rows
        .iter()
        .enumerate()
        .map(|(r, &id)| {
            let art: String = drawer.grid.cells[r].iter().collect();
            let art = art.trim_end();
            let home = cols[r] + LABEL_GUTTER;
            let start = home.max(art.chars().count() + 2);
            let pushed = start > home;
            Row { art: format!("{art:<width$}", width = if pushed { start - 1 } else { start }), pushed, id }
        })
        .collect())
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
    /// column, joining an existing lane into the same child, a short hop into the indentation
    /// shadow left of the parent (nothing new lands right of a node, so labels stay on the
    /// depth grid), dropping straight into the child's column, then any routable column further
    /// right, then further left.
    ///
    /// A lane hanging off a horizontal run (`┬`) belongs to that row's node: trace the run to
    /// its circle.
    ///
    /// Joining is offered only on the parent's last outgoing edge: a join's `┤` walls off the
    /// rest of the parent's row, which must stay routable while more edges remain.
    fn edge(&mut self, rp: usize, cp: usize, rc: usize, cc: usize, join_allowed: bool) -> bool {
        const LEFT_SLACK: usize = 2;
        assert!(rp < rc && cp < cc, "edges point down and right");
        if self.rail(rp, cp, rc, cc) || (join_allowed && self.join(rp, cp, rc)) {
            return true;
        }
        if self.scan_left(rp, cp, rc, cc, cp.saturating_sub(LEFT_SLACK)) || self.lane(rp, cp, rc, cc, cc) {
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
        self.scan_left(rp, cp, rc, cc, 0)
    }

    /// Try lanes leftward from the parent down to `floor`, stopping at impassable cells.
    fn scan_left(&mut self, rp: usize, cp: usize, rc: usize, cc: usize, floor: usize) -> bool {
        let mut col = cp;
        while col > floor {
            col -= 1;
            if self.lane(rp, cp, rc, cc, col) {
                return true;
            }
            if !passable(self.grid.get(rp, col)) {
                return false;
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
        let Some(run) = self.horizontal(rc, cp, cc) else { return false };
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
        let Some(run) = self.horizontal(rp, cp, col) else { return false };
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
            let Some(run) = self.horizontal(rc, col, cc) else { return false };
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
            let Some(run) = self.horizontal(rp, cp, col) else { continue };
            let mut writes = run;
            writes.push((rp, col, if col > cp { '┤' } else { '├' }));
            self.apply(writes);
            return true;
        }
        false
    }

    /// A horizontal run across the cells strictly between two columns. Runs exist only on node
    /// rows, and every corner glyph on a node's row belongs to that node's own plumbing (foreign
    /// edges cross a row only as verticals), so runs merge through corners: births become `┬`,
    /// arrivals and elbows become `┴`. Only three-way junctions and the node itself block.
    fn horizontal(&self, row: usize, a: usize, b: usize) -> Option<Writes> {
        let mut writes = Vec::new();
        for col in a.min(b) + 1..a.max(b) {
            let next = match self.grid.get(row, col) {
                ' ' | '─' => '─',
                '│' | '┼' => '┼',
                '╮' | '╭' | '┬' => '┬',
                '╰' | '╯' | '┴' => '┴',
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

/// Whether a horizontal run can cross this cell; the free-column scans stop at anything else.
fn passable(cell: char) -> bool {
    matches!(cell, ' ' | '─' | '│' | '┼' | '╮' | '╭' | '┬' | '╰' | '╯' | '┴')
}
