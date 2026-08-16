use cabaret_lib::{ChangeId, HomeGraph, HomeNode, render_home};
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
fn titles_follow_the_id() {
    let mut graph = graph(&[("add-parser", true, "main")]);
    graph.nodes.get_mut(&"add-parser".parse::<ChangeId>().unwrap()).unwrap().title = Some("Add the parser".into());
    expect![[r"
        ○   add-parser  Add the parser
    "]]
    .assert_eq(&render_home(&graph).unwrap().text);
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
