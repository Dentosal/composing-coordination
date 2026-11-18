//! `GET /api/version`: the version of the server binary (stamped in at build time) and of the client files being served
//! (read from their git checkout each time they are asked for, cached for a few seconds).

use crate::gitinfo::{describe, GitInfo};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn info_json(commit: &str, dirty: bool, fingerprint: Option<&str>) -> Value {
    let label = match fingerprint {
        Some(f) if dirty && !f.is_empty() => format!("{commit}+{f}"),
        _ => commit.to_string(),
    };
    json!({"label": label, "commit": commit, "dirty": dirty, "fingerprint": fingerprint.filter(|f| !f.is_empty())})
}

/// The server binary's version.
pub fn server_version() -> Value {
    let dirty = env!("BAND_GAME_DIRTY") == "true";
    info_json(env!("BAND_GAME_COMMIT"), dirty, Some(env!("BAND_GAME_FINGERPRINT")))
}

fn client_json(info: Option<&GitInfo>) -> Value {
    match info {
        Some(g) => info_json(&g.commit, g.dirty, g.fingerprint.as_deref()),
        None => json!({"label": "unknown", "commit": null, "dirty": null, "fingerprint": null}),
    }
}

static CLIENT_CACHE: Mutex<Option<(Instant, PathBuf, Value)>> = Mutex::new(None);

/// The version of the client files in `dir`: the commit checked out there, plus a mark and fingerprint of uncommitted
/// changes (the files are served straight from disk, so this follows edits and checkouts while the server runs).
pub fn client_version(dir: &Path) -> Value {
    let mut cache = CLIENT_CACHE.lock().unwrap();
    if let Some((at, d, v)) = cache.as_ref() {
        if d == dir && at.elapsed() < Duration::from_secs(3) {
            return v.clone();
        }
    }
    let v = client_json(describe(dir).as_ref());
    *cache = Some((Instant::now(), dir.to_path_buf(), v.clone()));
    v
}

pub async fn current(client_dir: PathBuf) -> Value {
    let client = tokio::task::spawn_blocking(move || client_version(&client_dir)).await.unwrap_or(Value::Null);
    json!({"server": server_version(), "client": client})
}
