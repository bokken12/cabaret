use cabaret_lib::{
    home::{HomeGraph, HomeNode},
    page::{Page, Target},
    types::{ChangeId, Identity},
};
use expect_test::{Expect, expect};

/// Nodes are (id, owned, space-separated parents). Parents that are not listed as nodes are
/// dropped, as `home_graph` drops trunk.
fn graph(nodes: &[(&str, bool, &str)]) -> HomeGraph {
    let ids: Vec<&str> = nodes.iter().map(|(id, ..)| *id).collect();
    let nodes = nodes
        .iter()
        .map(|(id, owned, parents)| {
            let node = HomeNode {
                title: None,
                owned: *owned,
                parents: parents
                    .split_whitespace()
                    .filter(|parent| ids.contains(parent))
                    .map(|parent| parent.parse().unwrap())
                    .collect(),
            };
            (id.parse().unwrap(), node)
        })
        .collect();
    HomeGraph { viewer: Identity("alice@example.com".into()), nodes }
}

fn titled(graph: &mut HomeGraph, id: &str, title: &str) {
    graph.nodes.get_mut(&id.parse::<ChangeId>().unwrap()).unwrap().title = Some(title.into());
}

/// Every row leads to the change it labels, and folds are well-formed.
fn check(nodes: &[(&str, bool, &str)], expect: &Expect) {
    let page = Page::home(&graph(nodes)).unwrap();
    expect.assert_eq(&page.to_string());
    for line in &page.lines {
        let Some(Target::Change { change }) = &line.target else { panic!("a home row leads to its change") };
        let text: String = line.segments.iter().map(|segment| segment.text.as_str()).collect();
        assert!(text.contains(&change.to_string()), "{text:?} does not label {change}");
    }
    let mut open: Vec<u32> = Vec::new();
    for fold in &page.folds {
        assert!(fold.start < fold.end, "a fold hides at least one line");
        assert!(usize::try_from(fold.end).unwrap() < page.lines.len(), "folds stay within the page");
        while open.last().is_some_and(|&end| end < fold.start) {
            open.pop();
        }
        if let Some(&end) = open.last() {
            assert!(fold.end <= end, "folds nest or stay disjoint");
        }
        open.push(fold.end);
    }
}

/// The page with each fold bracketed in the margin: `╭` on the row that folds, `│` along the
/// lines it hides, `╰` on the last, nested folds one column right of their enclosing one.
fn check_folds(nodes: &[(&str, bool, &str)], expect: &Expect) {
    let page = Page::home(&graph(nodes)).unwrap();
    let text = page.to_string();
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
    let bracketed: String = lines
        .iter()
        .zip(&margin)
        .map(|(line, cells)| {
            let cells: String = cells.iter().collect();
            if width == 0 { format!("{line}\n") } else { format!("{cells:<width$}  {line}\n") }
        })
        .collect();
    expect.assert_eq(&bracketed);
}

#[test]
fn a_linear_stack_renders_as_a_tree() {
    check(
        &[("add-parser", true, "main"), ("parser-tests", true, "add-parser"), ("parser-docs", true, "parser-tests")],
        &expect![[r"
            ○   add-parser
            ╰─○   parser-tests
              ╰─○   parser-docs
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
            ○   bump-deps
            ○   docs-typo
            ○   fix-login
            ○   stack-base
            ╰─○   stack-top
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
            ○   infra-core
            ├┬○   api-routes
            ╰┼○   ui-widgets
             ╰┴─○   integration
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
            ○   a1-parser
            ╰─○   a2-typed-ast
              ╰┬○   a3-parser-api
            ○  │ »b1-schema
            ╰─○│  b2-migrations
              ╰┼○   b3-storage-api
               ╰┴─○   integration
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
            ○┬╮ »feat-a
            ○┼┼╮ »feat-b
            ╰┼○│  int-ab
            ○│ │ »feat-c
            ├┴○│  int-ac
            ╰─○╯  int-bc
        "]],
    );
}

#[test]
fn unowned_ancestors_render_as_context() {
    check(
        &[("infra-core", false, "main"), ("my-feature", true, "infra-core")],
        &expect![[r"
            ◌   infra-core
            ╰─○   my-feature
        "]],
    );
}

#[test]
fn titles_sit_in_a_column_after_the_ids() {
    let mut graph =
        graph(&[("infra-core", false, "main"), ("api-routes", true, "infra-core"), ("ui", true, "api-routes")]);
    titled(&mut graph, "infra-core", "Core infrastructure");
    titled(&mut graph, "ui", "Add the UI");
    let page = Page::home(&graph).unwrap();
    expect![[r"
        ◌   infra-core    Core infrastructure
        ╰─○   api-routes
          ╰─○   ui        Add the UI
    "]]
    .assert_eq(&page.to_string());
    expect![[r"
        ◌   [Muted|infra-core]    [Muted|Core infrastructure] => change:infra-core
        ╰─○   [ChangeId|api-routes] => change:api-routes
          ╰─○   [ChangeId|ui]        Add the UI => change:ui
    "]]
    .assert_eq(&super::page::markup(&page));
}

#[test]
fn a_pushed_label_is_marked() {
    let page =
        Page::home(&graph(&[("feat-a", true, ""), ("feat-b", true, ""), ("int", true, "feat-a feat-b")])).unwrap();
    expect![[r"
        ○─╮ [Muted|»][ChangeId|feat-a] => change:feat-a
        ○ │ [Muted|»][ChangeId|feat-b] => change:feat-b
        ╰─○   [ChangeId|int] => change:int
    "]]
    .assert_eq(&super::page::markup(&page));
}

#[test]
fn a_parent_cycle_is_an_error() {
    let graph = graph(&[("a", true, "b"), ("b", true, "a")]);
    expect!["parent cycle involving a"].assert_eq(&format!("{:?}", Page::home(&graph).unwrap_err()));
}

#[test]
fn an_empty_graph_says_so() {
    expect![[r"
        no open changes owned by alice@example.com
    "]]
    .assert_eq(&Page::home(&graph(&[])).unwrap().to_string());
}

#[test]
fn every_stack_level_folds_in_a_linear_stack() {
    check_folds(
        &[("add-parser", true, "main"), ("parser-tests", true, "add-parser"), ("parser-docs", true, "parser-tests")],
        &expect![[r"
            ╭   ○   add-parser
            │╭  ╰─○   parser-tests
            ╰╰    ╰─○   parser-docs
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
            ╭  ○   infra-core
            │  ├┬○   api-routes
            │  ╰┼○   ui-widgets
            ╰   ╰┴─○   integration
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
            ○┬╮ »feat-a
            ○┼┼╮ »feat-b
            ╰┼○│  int-ab
            ○│ │ »feat-c
            ├┴○│  int-ac
            ╰─○╯  int-bc
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
            ╭   ○   base
            │   ├┬○   l1
            │   ╰┼○   r1
            │╭   ╰┴─○   mid
            ││      ├┬○   l2
            ││      ╰┼○   r2
            ╰╰       ╰┴─○   top
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
               ○   bump-deps
               ○   docs-typo
            ╭  ○   stack-base
            ╰  ╰─○   stack-top
        "]],
    );
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
            ○   root
            ├─○   kid-a
            ├─○   kid-b
            ├─○   kid-c
            ╰─○   kid-d
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
            ○─╮ »feat-a
            ○─┤ »feat-b
            ○ │ »feat-c
            ╰─○   integration
        "]],
    );
}

// TODO-someday(joel): transitive parents should be skipped prior to rendering
#[test]
fn a_transitive_parent_spans_levels() {
    check(
        &[("base", true, "main"), ("mid", true, "base"), ("top", true, "base mid")],
        &expect![[r"
            ○   base
            ├─○   mid
            ╰─┴─○   top
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
            ○   base
            ├┬○   l1
            ╰┼○   r1
             ╰┴─○   mid
                ├┬○   l2
                ╰┼○   r2
                 ╰┴─○   top
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
            ○   s1
            ╰─○   s2
              ╰─○   s3
                ╰─○   s4
                  ╰─○   s5
                    ╰─○   s6
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
            ○┬╮ »feat-a
            ○┼┼╮ »feat-b
            ╰┼○┼╮ »int-ab
            ○│ ││ »feat-c
            ├┴○┼┤ »int-ac
            ╰─○╯│ »int-bc
              ╰─○   release
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
            ○   infra
            ├┬○   api
            ││╰┬○   ui
            ╰┼○│  auth
             ╰┴┼◌   search
               ╰┴─○   release
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
            ○──┬──┬─╮ »c00
            ├┬○┼─┬┼╮│ »c01
            ╰┼○│ ││││ »c02
             ╰┴┼○││││ »c07
            ○  │ ││││ »c03
            ├──┴○┴┼┼┤ »c04
            │   ╰─○││ »c05
            ╰───○──╯│ »c06
                ╰─○─╯ »c09
            ○   c08
        "]],
    );
}
