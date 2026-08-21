//! Single test binary. `unit` tests exercise pure pieces directly; `integration` tests
//! drive a `Cabaret` on a fixture repo.

/// A test file in a subfolder runs only if its `mod.rs` declares it.
#[test]
fn no_forgotten_test_files() {
    for dir in ["unit", "integration"] {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(dir);
        let declared = std::fs::read_to_string(root.join("mod.rs")).unwrap();
        for entry in std::fs::read_dir(&root).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            let Some(module) = name.strip_suffix(".rs") else { continue };
            if module == "mod" {
                continue;
            }
            assert!(
                declared.contains(&format!("mod {module};")),
                "tests/{dir}/{name} is not declared in tests/{dir}/mod.rs, so it never runs"
            );
        }
    }
}
