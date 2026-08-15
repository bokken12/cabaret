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

fn check(nodes: &[(&str, bool, &str)], expect: &Expect) { expect.assert_eq(&render_home(&graph(nodes)).unwrap()); }

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
            ├─○─╮  api-routes
            ╰─○ │  ui-widgets
              ╰─○   integration
        "]],
    );
}

#[test]
fn an_integration_of_two_stacks_stays_two_columns_wide() {
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
              ╰─○─╮  a3-parser-api
            ○     │  b1-schema
            ╰─○   │  b2-migrations
              ╰─○ │  b3-storage-api
                ╰─○   integration
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
            ○┬╮  feat-a
            ○┼┼╮  feat-b
            ╰┼○│  int-ab
            ○│ │  feat-c
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
    .assert_eq(&render_home(&graph).unwrap());
}

#[test]
fn a_parent_cycle_is_an_error() {
    let graph = graph(&[("a", true, "b"), ("b", true, "a")]);
    expect!["parent cycle involving a"].assert_eq(&format!("{:?}", render_home(&graph).unwrap_err()));
}

#[test]
fn an_empty_graph_renders_as_nothing() {
    assert_eq!(render_home(&graph(&[])).unwrap(), "");
}
