use cabaret_lib::render::render_home;
use expect_test::expect;

use super::fixture::{carol, troupe};

#[test]
fn the_home_graph_is_owned_changes_plus_open_ancestors_as_context() {
    let fixture = troupe();
    let graph = fixture.cabaret.home_graph(&carol()).unwrap();
    expect![[r"
        ◌   infra-core       land          Core plumbing
        ├┬◌   api-routes     land          Route the API
        ╰┼◌   ui-widgets     land
         ╰┴─○   integration  land parents
        ○   docs-polish      land          Polish the guide
    "]]
    .assert_eq(&render_home(&graph).unwrap().text);
}
