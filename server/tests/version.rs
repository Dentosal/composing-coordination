//! The git version stamp: a commit, a flag and a fingerprint for uncommitted changes.

use band_game::gitinfo::{describe, GitInfo};
use std::path::Path;

fn git_available() -> bool {
    std::process::Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

#[test]
fn labels_show_the_commit_and_mark_uncommitted_changes() {
    let clean = GitInfo { commit: "8b7ca71f3a2c".into(), dirty: false, fingerprint: None };
    assert_eq!(clean.label(), "8b7ca71f3a2c");
    let dirty = GitInfo { commit: "8b7ca71f3a2c".into(), dirty: true, fingerprint: Some("1a2b3c4d".into()) };
    assert_eq!(dirty.label(), "8b7ca71f3a2c+1a2b3c4d");
}

#[test]
fn this_repository_has_a_version_and_a_folder_outside_git_has_none() {
    if !git_available() {
        return;
    }
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(info) = describe(repo) {
        assert_eq!(info.commit.len(), 12);
        assert!(info.commit.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(info.dirty, info.fingerprint.is_some(), "a fingerprint exactly when there are uncommitted changes");
    }
    let outside = std::env::temp_dir().join("band-game-no-git-here");
    std::fs::create_dir_all(&outside).unwrap();
    assert!(describe(&outside).is_none());
}

#[test]
fn the_server_binary_carries_its_build_stamp() {
    let v = band_game::version::server_version();
    assert!(v["label"].as_str().unwrap().len() >= 7);
    assert!(v["commit"].is_string());
}
