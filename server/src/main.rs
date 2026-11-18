use axum::{http::{header, HeaderValue}, middleware, response::Response};
use band_game::{api, state::Shared};
use std::sync::Arc;
use tower_http::services::ServeDir;

#[tokio::main]
async fn main() {
    let shared: Shared = Arc::new(Default::default());
    let client_dir = std::env::var("CLIENT_DIR").unwrap_or_else(|_| "../client".into());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);

    // Static client files are revalidated on every load (cheap 304s), so edits show up without a hard refresh.
    // Responses that set their own Cache-Control (the immutable mix WAVs) keep it.
    let app = api::router(shared)
        .fallback_service(ServeDir::new(&client_dir).append_index_html_on_directories(true))
        .layer(middleware::map_response(|mut r: Response| async move {
            r.headers_mut().entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static("no-cache"));
            r
        }));
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
    println!("band-game listening on http://localhost:{port} (client: {client_dir})");
    axum::serve(listener, app).await.unwrap();
}
