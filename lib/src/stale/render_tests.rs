use cabaret_lib::{
    change::ChangeId,
    home::{HomeGraph, HomeNode},
    render::render_home,
    step::NextStep,
};
use expect_test::{Expect, expect};

/// Nodes are (id, owned, space-separated parents). Parents that are not listed as nodes are
/// dropped, as `home_graph` drops trunk branches.
fn graph(nodes: &[(&str, bool, &str)]) -> HomeGraph {
    let ids: Vec<&str> = nodes.iter().map(|(id, ..)| *id).collect();
    let nodes = nodes
        .iter()
        .map(|(id, owned, parents)| {
            let node = HomeNode {
                title: None,
                owned: *owned,
                step: NextStep::Land,
                parents: parents
                    .split_whitespace()
                    .filter(|parent| ids.contains(parent))
                    .map(|parent| parent.parse().unwrap())
                    .collect(),
            };
            (id.parse().unwrap(), node)
        })
        .collect();
    HomeGraph { nodes }
}

fn check(nodes: &[(&str, bool, &str)], expect: &Expect) {
    let home = render_home(&graph(nodes)).unwrap();
    expect.assert_eq(&home.text);
    assert_eq!(home.rows.len(), home.text.lines().count());
    for (line, row) in home.text.lines().zip(&home.rows) {
        let id = row.change.to_string();
        let start = usize::try_from(row.label_start).unwrap();
        let label: String = line.chars().skip(start).take(id.chars().count()).collect();
        assert_eq!(label, id, "label offset misses the id in {line:?}");
    }
    let mut open: Vec<u32> = Vec::new();
    for fold in &home.folds {
        assert!(fold.start < fold.end, "a fold hides at least one line");
        assert!(usize::try_from(fold.end).unwrap() < home.rows.len(), "folds stay within the view");
        while open.last().is_some_and(|&end| end < fold.start) {
            open.pop();
        }
        if let Some(&end) = open.last() {
            assert!(fold.end <= end, "folds nest or stay disjoint");
        }
        open.push(fold.end);
    }
}

/// The home view with each fold bracketed in the margin: `╭` on the row that folds, `│` along
/// the lines it hides, `╰` on the last, nested folds one column right of their enclosing one.
fn check_folds(nodes: &[(&str, bool, &str)], expect: &Expect) {
    let home = render_home(&graph(nodes)).unwrap();
    let lines: Vec<&str> = home.text.lines().collect();
    let mut margin = vec![Vec::<char>::new(); lines.len()];
    let mut active: Vec<u32> = Vec::new();
    for fold in &home.folds {
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
            row[col] = if r == start {
                '╭'
            } else if r == end {
                '╰'
            } else {
                '│'
            };
        }
    }
    // A foldless view keeps no margin: a uniform one would not survive expect's dedent anyway.
    let width = margin.iter().map(Vec::len).max().unwrap_or(0);
    let text: String = lines
        .iter()
        .zip(&margin)
        .map(|(line, cells)| {
            let cells: String = cells.iter().collect();
            if width == 0 { format!("{line}\n") } else { format!("{cells:<width$}  {line}\n") }
        })
        .collect();
    expect.assert_eq(&text);
}

#[test]
fn a_linear_stack_renders_as_a_tree() {
    check(
        &[("add-parser", true, "main"), ("parser-tests", true, "add-parser"), ("parser-docs", true, "parser-tests")],
        &expect![[r"
            ○   add-parser       land
            ╰─○   parser-tests   land
              ╰─○   parser-docs  land
        "]],
    );
}

#[test]
fn independent_components_pack_with_no_separator() {
    check(
        &[
            ("bump-deps", true, "main"),
            ("docs-typo", true, "main"),
            ("fix-login", true, "main"),
            ("stack-base", true, "main"),
            ("stack-top", true, "stack-base"),
        ],
        &expect![[r"
            ○   bump-deps    land
            ○   docs-typo    land
            ○   fix-login    land
            ○   stack-base   land
            ╰─○   stack-top  land
        "]],
    );
}

#[test]
fn a_diamond_closes_instead_of_duplicating() {
    check(
        &[
            ("infra-core", true, "main"),
            ("api-routes", true, "infra-core"),
            ("ui-widgets", true, "infra-core"),
            ("integration", true, "api-routes ui-widgets"),
        ],
        &expect![[r"
            ○   infra-core       land
            ├┬○   api-routes     land
            ╰┼○   ui-widgets     land
             ╰┴─○   integration  land
        "]],
    );
}

#[test]
fn an_integration_of_two_stacks_stays_narrow() {
    check(
        &[
            ("a1-parser", true, "main"),
            ("a2-typed-ast", true, "a1-parser"),
            ("a3-parser-api", true, "a2-typed-ast"),
            ("b1-schema", true, "main"),
            ("b2-migrations", true, "b1-schema"),
            ("b3-storage-api", true, "b2-migrations"),
            ("integration", true, "a3-parser-api b3-storage-api"),
        ],
        &expect![[r"
            ○   a1-parser           land
            ╰─○   a2-typed-ast      land
              ╰┬○   a3-parser-api   land
            ○  │ »b1-schema         land
            ╰─○│  b2-migrations     land
              ╰┼○   b3-storage-api  land
               ╰┴─○   integration   land
        "]],
    );
}

#[test]
fn pairwise_integrations_route_without_duplication() {
    check(
        &[
            ("feat-a", true, "main"),
            ("feat-b", true, "main"),
            ("feat-c", true, "main"),
            ("int-ab", true, "feat-a feat-b"),
            ("int-ac", true, "feat-a feat-c"),
            ("int-bc", true, "feat-b feat-c"),
        ],
        &expect![[r"
            ○┬╮ »feat-a   land
            ○┼┼╮ »feat-b  land
            ╰┼○│  int-ab  land
            ○│ │ »feat-c  land
            ├┴○│  int-ac  land
            ╰─○╯  int-bc  land
        "]],
    );
}

#[test]
fn unowned_ancestors_render_as_context() {
    check(
        &[("infra-core", false, "main"), ("my-feature", true, "infra-core")],
        &expect![[r"
            ◌   infra-core    land
            ╰─○   my-feature  land
        "]],
    );
}

#[test]
fn titles_follow_the_id() {
    let mut graph = graph(&[("add-parser", true, "main")]);
    graph.nodes.get_mut(&"add-parser".parse::<ChangeId>().unwrap()).unwrap().title = Some("Add the parser".into());
    expect![[r"
        ○   add-parser  land  Add the parser
    "]]
    .assert_eq(&render_home(&graph).unwrap().text);
}

#[test]
fn steps_and_titles_sit_in_aligned_columns() {
    fn node<'a>(graph: &'a mut HomeGraph, id: &str) -> &'a mut HomeNode {
        graph.nodes.get_mut(&id.parse::<ChangeId>().unwrap()).unwrap()
    }
    let mut graph = graph(&[("infra-core", true, "main"), ("api-routes", true, "infra-core")]);
    node(&mut graph, "infra-core").step = NextStep::FixConflicts;
    node(&mut graph, "api-routes").step = NextStep::AddCode;
    node(&mut graph, "api-routes").title = Some("Add the API routes".into());
    expect![[r"
        ○   infra-core    fix conflicts
        ╰─○   api-routes  add code       Add the API routes
    "]]
    .assert_eq(&render_home(&graph).unwrap().text);
}

#[test]
fn every_stack_level_folds_in_a_linear_stack() {
    check_folds(
        &[("add-parser", true, "main"), ("parser-tests", true, "add-parser"), ("parser-docs", true, "parser-tests")],
        &expect![[r"
            ╭   ○   add-parser       land
            │╭  ╰─○   parser-tests   land
            ╰╰    ╰─○   parser-docs  land
        "]],
    );
}

#[test]
fn only_a_diamonds_root_folds_it() {
    // ui-widgets sits right above integration, but folding it would hide api-routes's child.
    check_folds(
        &[
            ("infra-core", true, "main"),
            ("api-routes", true, "infra-core"),
            ("ui-widgets", true, "infra-core"),
            ("integration", true, "api-routes ui-widgets"),
        ],
        &expect![[r"
            ╭  ○   infra-core       land
            │  ├┬○   api-routes     land
            │  ╰┼○   ui-widgets     land
            ╰   ╰┴─○   integration  land
        "]],
    );
}

#[test]
fn a_web_of_shared_descendants_never_folds() {
    check_folds(
        &[
            ("feat-a", true, "main"),
            ("feat-b", true, "main"),
            ("feat-c", true, "main"),
            ("int-ab", true, "feat-a feat-b"),
            ("int-ac", true, "feat-a feat-c"),
            ("int-bc", true, "feat-b feat-c"),
        ],
        &expect![[r"
              ○┬╮ »feat-a   land
              ○┼┼╮ »feat-b  land
              ╰┼○│  int-ab  land
              ○│ │ »feat-c  land
              ├┴○│  int-ac  land
              ╰─○╯  int-bc  land
        "]],
    );
}

#[test]
fn a_self_contained_subtree_folds_under_messy_parents() {
    check_folds(
        &[
            ("base", true, "main"),
            ("l1", true, "base"),
            ("r1", true, "base"),
            ("mid", true, "l1 r1"),
            ("l2", true, "mid"),
            ("r2", true, "mid"),
            ("top", true, "l2 r2"),
        ],
        &expect![[r"
            ╭   ○   base         land
            │   ├┬○   l1         land
            │   ╰┼○   r1         land
            │╭   ╰┴─○   mid      land
            ││      ├┬○   l2     land
            ││      ╰┼○   r2     land
            ╰╰       ╰┴─○   top  land
        "]],
    );
}

#[test]
fn folds_stay_within_their_component() {
    check_folds(
        &[
            ("bump-deps", true, "main"),
            ("docs-typo", true, "main"),
            ("stack-base", true, "main"),
            ("stack-top", true, "stack-base"),
        ],
        &expect![[r"
               ○   bump-deps    land
               ○   docs-typo    land
            ╭  ○   stack-base   land
            ╰  ╰─○   stack-top  land
        "]],
    );
}

#[test]
fn a_parent_cycle_is_an_error() {
    let graph = graph(&[("a", true, "b"), ("b", true, "a")]);
    expect!["parent cycle involving a"].assert_eq(&format!("{:?}", render_home(&graph).unwrap_err()));
}

#[test]
fn an_empty_graph_renders_as_nothing() {
    let home = render_home(&graph(&[])).unwrap();
    assert_eq!(home.text, "");
    assert!(home.rows.is_empty());
}

#[test]
fn a_wide_fan_out_rails_like_a_tree() {
    check(
        &[
            ("root", true, "main"),
            ("kid-a", true, "root"),
            ("kid-b", true, "root"),
            ("kid-c", true, "root"),
            ("kid-d", true, "root"),
        ],
        &expect![[r"
            ○   root     land
            ├─○   kid-a  land
            ├─○   kid-b  land
            ├─○   kid-c  land
            ╰─○   kid-d  land
        "]],
    );
}

// TODO-someday(joel): what if the vertical ran to the left of the parents here?
#[test]
fn a_three_parent_integration_merges_once() {
    check(
        &[
            ("feat-a", true, "main"),
            ("feat-b", true, "main"),
            ("feat-c", true, "main"),
            ("integration", true, "feat-a feat-b feat-c"),
        ],
        &expect![[r"
            ○─╮ »feat-a        land
            ○─┤ »feat-b        land
            ○ │ »feat-c        land
            ╰─○   integration  land
        "]],
    );
}

// TODO-someday(joel): transitive parents should be skipped prior to rendering
#[test]
fn a_transitive_parent_spans_levels() {
    check(
        &[("base", true, "main"), ("mid", true, "base"), ("top", true, "base mid")],
        &expect![[r"
            ○   base     land
            ├─○   mid    land
            ╰─┴─○   top  land
        "]],
    );
}

#[test]
fn stacked_diamonds_reuse_the_shadow() {
    check(
        &[
            ("base", true, "main"),
            ("l1", true, "base"),
            ("r1", true, "base"),
            ("mid", true, "l1 r1"),
            ("l2", true, "mid"),
            ("r2", true, "mid"),
            ("top", true, "l2 r2"),
        ],
        &expect![[r"
            ○   base         land
            ├┬○   l1         land
            ╰┼○   r1         land
             ╰┴─○   mid      land
                ├┬○   l2     land
                ╰┼○   r2     land
                 ╰┴─○   top  land
        "]],
    );
}

#[test]
fn a_deep_stack_staircases() {
    check(
        &[
            ("s1", true, "main"),
            ("s2", true, "s1"),
            ("s3", true, "s2"),
            ("s4", true, "s3"),
            ("s5", true, "s4"),
            ("s6", true, "s5"),
        ],
        &expect![[r"
            ○   s1            land
            ╰─○   s2          land
              ╰─○   s3        land
                ╰─○   s4      land
                  ╰─○   s5    land
                    ╰─○   s6  land
        "]],
    );
}

#[test]
fn a_release_atop_pairwise_integrations() {
    check(
        &[
            ("feat-a", true, "main"),
            ("feat-b", true, "main"),
            ("feat-c", true, "main"),
            ("int-ab", true, "feat-a feat-b"),
            ("int-ac", true, "feat-a feat-c"),
            ("int-bc", true, "feat-b feat-c"),
            ("release", true, "int-ab int-ac int-bc"),
        ],
        &expect![[r"
            ○┬╮ »feat-a      land
            ○┼┼╮ »feat-b     land
            ╰┼○┼╮ »int-ab    land
            ○│ ││ »feat-c    land
            ├┴○┼┤ »int-ac    land
            ╰─○╯│ »int-bc    land
              ╰─○   release  land
        "]],
    );
}

#[test]
fn a_mixed_web_routes_around_its_own_plumbing() {
    check(
        &[
            ("infra", true, "main"),
            ("auth", true, "infra"),
            ("api", true, "infra"),
            ("ui", true, "api"),
            ("search", false, "api auth"),
            ("release", true, "ui search"),
        ],
        &expect![[r"
            ○   infra          land
            ├┬○   api          land
            ││╰┬○   ui         land
            ╰┼○│  auth         land
             ╰┴┼◌   search     land
               ╰┴─○   release  land
        "]],
    );
}

// Once a randomized-search counterexample: c01's later edges had to route past the plumbing its
// earlier edges left behind.
#[test]
fn a_dense_thicket_routes_completely() {
    check(
        &[
            ("c00", true, ""),
            ("c01", true, "c00"),
            ("c02", true, "c00"),
            ("c03", true, ""),
            ("c04", true, "c00 c01 c03"),
            ("c05", true, "c00 c04"),
            ("c06", true, "c01 c03"),
            ("c07", true, "c01 c02"),
            ("c08", true, ""),
            ("c09", true, "c00 c04 c06"),
        ],
        &expect![[r"
            ○──┬──┬─╮ »c00  land
            ├┬○┼─┬┼╮│ »c01  land
            ╰┼○│ ││││ »c02  land
             ╰┴┼○││││ »c07  land
            ○  │ ││││ »c03  land
            ├──┴○┴┼┼┤ »c04  land
            │   ╰─○││ »c05  land
            ╰───○──╯│ »c06  land
                ╰─○─╯ »c09  land
            ○   c08         land
        "]],
    );
}
