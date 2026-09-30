//! Single test binary.

mod unit;

/// A test file in `unit` runs only if its `mod.rs` declares it.
#[test]
fn no_forgotten_test_files() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/unit");
    let declared = std::fs::read_to_string(root.join("mod.rs")).unwrap();
    for entry in std::fs::read_dir(&root).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        let Some(module) = name.strip_suffix(".rs") else { continue };
        if module == "mod" {
            continue;
        }
        assert!(
            declared.contains(&format!("mod {module};")),
            "tests/unit/{name} is not declared in tests/unit/mod.rs, so it never runs"
        );
    }
}
