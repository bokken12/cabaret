//! `cab sync` as run from a shell, where a closed pipe is fatal unless the command says otherwise.

use std::{path::Path, process::Command};

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=Alice Test", "-c", "user.email=alice@example.com"])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

/// gix reaches a local origin through a `git-upload-pack` child, and writes to it after it has
/// closed its end.
#[test]
fn survives_origin_closing_its_end() {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "--quiet", "--bare", "origin.git"]);
    git(root.path(), &["init", "--quiet", "--initial-branch", "main", "clone"]);
    let clone = root.path().join("clone");
    git(&clone, &["commit", "--quiet", "--allow-empty", "--message", "root"]);
    git(&clone, &["remote", "add", "origin", "../origin.git"]);
    git(&clone, &["push", "--quiet", "origin", "main"]);

    let synced = Command::new(env!("CARGO_BIN_EXE_cab")).current_dir(&clone).arg("sync").output().unwrap();
    assert!(synced.status.success(), "{synced:?}");
}
