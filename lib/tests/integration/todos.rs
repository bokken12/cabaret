//! The TODOs a change adds: lines its diff adds that mention one, wherever the file stands.

use expect_test::expect;

use super::fixture::{Fixture, alice, id};

fn todos(fixture: &Fixture, change: &str) -> String {
    let lines = fixture.cabaret.todos(&id(change)).unwrap();
    lines.iter().map(|line| format!("{}:{}: {}\n", line.path, line.number, line.text)).collect()
}

#[test]
fn added_file() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("new.rs", "fn f() {}\n// TODO(claude): name this\n")]);
    expect![[r#"
        new.rs:2: // TODO(claude): name this
    "#]]
    .assert_eq(&todos(&fixture, "change"));
}

#[test]
fn only_added_lines_of_modified_file() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.rs", "// TODO: old\nkeep\n")]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("file.rs", "// TODO: old\nkeep\n// TODO: new\r\n")]);
    expect![[r#"
        file.rs:3: // TODO: new
    "#]]
    .assert_eq(&todos(&fixture, "change"));
}

#[test]
fn removed_todo_has_none() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.rs", "// TODO: done\n"), ("gone.rs", "// TODO: gone\n")]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("file.rs", "done\n")]);
    fixture.remove("change", &["gone.rs"]);
    expect![""].assert_eq(&todos(&fixture, "change"));
}

#[test]
fn renamed_file_adds_only_its_edits() {
    let fixture = Fixture::new();
    fixture.root("main", &[("old.rs", "// TODO: moved\na\nb\nc\n")]);
    fixture.create("change", "main", &alice());
    fixture.remove("change", &["old.rs"]);
    fixture.commit("change", &[("new.rs", "// TODO: moved\na\nb\nc\n// TODO: added\n")]);
    expect![[r#"
        new.rs:5: // TODO: added
    "#]]
    .assert_eq(&todos(&fixture, "change"));
}

#[test]
fn parents_todos_excluded() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.commit("parent", &[("parent.rs", "// TODO: parent\n")]);
    fixture.create("child", "parent", &alice());
    fixture.commit("child", &[("child.rs", "// TODO: child\n")]);
    expect![[r#"
        child.rs:1: // TODO: child
    "#]]
    .assert_eq(&todos(&fixture, "child"));
}

#[test]
fn binary_file_has_none() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("change", "main", &alice());
    fixture.commit("change", &[("image.bin", "\0TODO\n")]);
    expect![""].assert_eq(&todos(&fixture, "change"));
}
