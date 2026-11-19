use axum::{http::{header, HeaderValue}, middleware, response::Response, routing::get, Json, Router};
use band_game::{api, state::Shared};
use std::sync::Arc;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;

#[tokio::main]
async fn main() {
    let shared: Shared = Arc::new(Default::default());
    band_game::state::spawn_sweeper(shared.clone()); // idle sessions are removed after an hour
    let client_dir = std::env::var("CLIENT_DIR").unwrap_or_else(|_| "../client".into());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);

    // Static client files are revalidated on every load (cheap 304s), so edits show up without a hard refresh.
    // Responses that set their own Cache-Control (the immutable mix WAVs) keep it.
    // Which code produced a scene file or a bug report: the server binary's commit and the client files' commit.
    let version_dir = std::path::PathBuf::from(&client_dir);
    let version = Router::new().route("/api/version", get(move || {
        let dir = version_dir.clone();
        async move { Json(band_game::version::current(dir).await) }
    }));
    let app = api::router(shared)
        .merge(version)
        .fallback_service(ServeDir::new(&client_dir).append_index_html_on_directories(true))
        .layer(middleware::map_response(|mut r: Response| async move {
            let h = r.headers_mut();
            h.entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static("no-cache"));
            // Cross-origin isolation, which the browser requires before a page may use SharedArrayBuffer (the
            // streaming player's ring buffer between its render worker and the audio thread). The client loads
            // nothing from other origins, so this costs nothing; a server in front of this one must keep them.
            h.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
            h.insert("cross-origin-embedder-policy", HeaderValue::from_static("require-corp"));
            r
        }))
        // Brotli or gzip, as the browser accepts: the client files and JSON (the WebAssembly renderer goes from 770 KB
        // to about 265 KB with brotli). Not the event stream (the default leaves it alone, so events are never held
        // back) and not WAV audio, which hardly compresses.
        .layer(CompressionLayer::new().compress_when(DefaultPredicate::new().and(NotForContentType::const_new("audio/"))));
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
    println!("band-game listening on http://localhost:{port} (client: {client_dir})");
    axum::serve(listener, app).await.unwrap();
}
