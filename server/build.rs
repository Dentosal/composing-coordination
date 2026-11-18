// Embeds the git state of the server's sources into the binary, so /api/version can say which code is really running.
#[path = "src/gitinfo.rs"]
mod gitinfo;

fn main() {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let info = gitinfo::describe(std::path::Path::new(&dir));
    let (commit, dirty, fp) = match &info {
        Some(i) => (i.commit.clone(), i.dirty, i.fingerprint.clone().unwrap_or_default()),
        None => ("unknown".to_string(), false, String::new()),
    };
    println!("cargo:rustc-env=BAND_GAME_COMMIT={commit}");
    println!("cargo:rustc-env=BAND_GAME_DIRTY={dirty}");
    println!("cargo:rustc-env=BAND_GAME_FINGERPRINT={fp}");
    // Rebuild the stamp when the sources or the checked-out commit change.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    for p in ["../.git/HEAD", "../.git/index"] {
        if std::path::Path::new(p).exists() {
            println!("cargo:rerun-if-changed={p}");
        }
    }
}
