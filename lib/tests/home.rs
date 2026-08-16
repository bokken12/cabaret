mod fixture;

use cabaret_lib::{Identity, render_home};
use expect_test::expect;
use fixture::Fixture;

fn alice() -> Identity { Identity("alice@example.com".into()) }

#[test]
fn the_home_graph_is_owned_changes_plus_open_ancestors_as_context() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "main\n")], &[]);
    let infra = fixture.commit("refs/heads/infra", &[("infra.txt", "infra\n")], &[root]);
    fixture.commit("refs/heads/feature", &[("feature.txt", "feature\n")], &[infra]);
    fixture.commit("refs/heads/unrelated", &[("unrelated.txt", "unrelated\n")], &[root]);
    // main has no log: it is trunk and never appears.
    fixture.set_parents("infra", &["main"]);
    fixture.set_parents("feature", &["infra"]);
    fixture.set_parents("unrelated", &["main"]);
    let cabaret = &fixture.cabaret;
    cabaret.add_owner(&"feature".parse().unwrap(), &alice()).unwrap();
    cabaret.add_owner(&"infra".parse().unwrap(), &Identity("bob@example.com".into())).unwrap();
    cabaret.add_owner(&"unrelated".parse().unwrap(), &Identity("bob@example.com".into())).unwrap();
    cabaret.set_title(&"feature".parse().unwrap(), Some("My feature".into())).unwrap();

    let graph = cabaret.home_graph(&alice()).unwrap();
    expect![[r"
        ◌   infra      land
        ╰─○   feature  land  My feature
    "]]
    .assert_eq(&render_home(&graph).unwrap().text);
}
