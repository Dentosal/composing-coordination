//! Which version of some code is this? A short git commit, whether the tree has uncommitted changes, and a short
//! fingerprint of those changes (so two runs from the same uncommitted state can be recognised). Uses only the standard
//! library, because the build script includes this file too.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Clone, Debug, PartialEq)]
pub struct GitInfo {
    /// Short commit hash (12 characters) of HEAD.
    pub commit: String,
    pub dirty: bool,
    /// Present when `dirty`: a hash of the uncommitted changes (tracked diff plus the contents of untracked files).
    pub fingerprint: Option<String>,
}

#[allow(dead_code)] // the build script includes this file but only uses `describe`
impl GitInfo {
    /// "8b7ca71f3a2c" for a clean tree, "8b7ca71f3a2c+1a2b3c4d" for that commit plus uncommitted changes.
    pub fn label(&self) -> String {
        match &self.fingerprint {
            Some(f) if self.dirty => format!("{}+{}", self.commit, f),
            _ => self.commit.clone(),
        }
    }
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Hash `text` the way git hashes a file (so no extra hashing dependency is needed).
fn hash_text(text: &str) -> Option<String> {
    let mut child = Command::new("git").args(["hash-object", "--stdin"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    child.stdin.take()?.write_all(text.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().chars().take(8).collect())
}

/// The state of the files under `dir` (only the files there, not the rest of the repository), or None when `dir` is not
/// in a git repository or git is not available.
pub fn describe(dir: &Path) -> Option<GitInfo> {
    let commit = git(dir, &["rev-parse", "--short=12", "HEAD"])?.trim().to_string();
    if commit.is_empty() {
        return None;
    }
    let status = git(dir, &["status", "--porcelain", "--", "."])?;
    let dirty = !status.trim().is_empty();
    let fingerprint = dirty.then(|| {
        let mut text = git(dir, &["diff", "HEAD", "--", "."]).unwrap_or_default();
        for path in git(dir, &["ls-files", "--others", "--exclude-standard", "--", "."]).unwrap_or_default().lines() {
            let h = git(dir, &["hash-object", "--", path]).unwrap_or_default();
            text.push_str(&format!("\nuntracked {path} {}", h.trim()));
        }
        hash_text(&text).unwrap_or_else(|| "unknown".into())
    });
    Some(GitInfo { commit, dirty, fingerprint })
}
