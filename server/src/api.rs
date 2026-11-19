//! HTTP handlers.

use crate::orders::Orders;
use crate::state::*;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use uuid::Uuid;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

type Q = Query<HashMap<String, String>>;

pub fn router(shared: Shared) -> Router {
    Router::new()
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/{id}/info", get(info))
        .route("/api/sessions/{id}/join", post(join))
        .route("/api/sessions/{id}/start", post(start))
        .route("/api/sessions/{id}/end", post(end))
        .route("/api/sessions/{id}/state", get(get_state))
        .route("/api/sessions/{id}/orders", put(put_orders))
        .route("/api/sessions/{id}/ready", post(ready))
        .route("/api/sessions/{id}/name", put(set_name))
        .route("/api/sessions/{id}/players/{seat}/kick", post(kick))
        .route("/api/sessions/{id}/players/{seat}/admit", post(admit))
        .route("/api/sessions/{id}/bars", put(set_bars))
        .route("/api/sessions/{id}/bpm", put(set_bpm))
        .route("/api/sessions/{id}/rounds/{n}/mix.wav", get(mix))
        .route("/api/sessions/{id}/rounds/{n}/parts", get(round_parts))
        .route("/api/sessions/{id}/song.wav", get(song))
        .route("/api/sessions/{id}/render", post(render_part))
        .route("/api/sessions/{id}/song-so-far.wav", get(song_so_far))
        .route("/api/sessions/{id}/events", get(events))
        .layer(axum::extract::DefaultBodyLimit::max(4 * 1024 * 1024)) // 64 tracks with every row of a 256-bar song filled is about 1.8 MB
        .with_state(shared)
}

fn token_from(headers: &HeaderMap, q: &HashMap<String, String>) -> Result<Uuid, ApiError> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
        .or_else(|| q.get("token").cloned());
    raw.and_then(|t| Uuid::parse_str(t.trim()).ok())
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "missing or invalid token".into()))
}

/// The session `id`, marked as in use (every route finds its session through here or `session_mut`).
fn session<'a>(g: &'a AppState, id: &str) -> Result<&'a Session, ApiError> {
    let s = g.sessions.get(id).ok_or(ApiError(StatusCode::NOT_FOUND, "no such session".into()))?;
    s.touch();
    Ok(s)
}

fn session_mut<'a>(g: &'a mut AppState, id: &str) -> Result<&'a mut Session, ApiError> {
    let s = g.sessions.get_mut(id).ok_or(ApiError(StatusCode::NOT_FOUND, "no such session".into()))?;
    s.touch();
    Ok(s)
}

/// Resolve auth to a seat index (host token alone is not a seat).
fn seat_of(s: &Session, h: &HeaderMap, q: &HashMap<String, String>) -> Result<usize, ApiError> {
    match s.auth(token_from(h, q)?) {
        Some(Who::Seat(i)) => Ok(i),
        _ => err(StatusCode::FORBIDDEN, "seat token required"),
    }
}

fn any_auth(s: &Session, h: &HeaderMap, q: &HashMap<String, String>) -> Result<Who, ApiError> {
    s.auth(token_from(h, q)?).ok_or(ApiError(StatusCode::FORBIDDEN, "invalid token".into()))
}

async fn create_session(State(sh): State<Shared>, body: Option<Json<Config>>) -> Result<Json<Value>, ApiError> {
    let config = body.map(|b| b.0).unwrap_or_default();
    config.validate().map_err(|m| ApiError(StatusCode::BAD_REQUEST, m))?;
    let s = Session::new(config);
    let out = json!({"session_id": s.id, "host_token": s.host_token});
    let mut g = sh.write().await;
    if g.sessions.len() >= MAX_SESSIONS {
        return err(StatusCode::SERVICE_UNAVAILABLE, "too many sessions");
    }
    g.sessions.insert(s.id.clone(), s);
    Ok(Json(out))
}

/// Public info for the join screen (no auth): config and seat counts only.
async fn info(State(sh): State<Shared>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let g = sh.read().await;
    let s = session(&g, &id)?;
    Ok(Json(json!({
        "config": s.config, "phase": s.phase,
        "seat_count": s.seat_count(),
    })))
}

#[derive(Deserialize, Default)]
struct NameBody {
    name: Option<String>,
}

/// Take a seat. The body `{"name": "..."}` is the nickname (optional: "Player N" without one).
async fn join(State(sh): State<Shared>, Path(id): Path<String>, body: Option<Json<NameBody>>) -> Result<Json<Value>, ApiError> {
    let name = body.and_then(|b| b.0.name);
    let mut g = sh.write().await;
    let s = session_mut(&mut g, &id)?;
    let token = s.join_as(name.as_deref())?;
    tokio::spawn(offline_check(sh.clone(), id, s.seats.len() - 1)); // in case the page never connects
    Ok(Json(json!({"seat_token": token})))
}

/// Change the caller's nickname: `{"name": "..."}`.
async fn set_name(
    State(sh): State<Shared>,
    Path(id): Path<String>,
    h: HeaderMap,
    q: Q,
    Json(body): Json<NameBody>,
) -> Result<Json<Value>, ApiError> {
    let mut g = sh.write().await;
    let s = session_mut(&mut g, &id)?;
    let seat = seat_of(s, &h, &q)?;
    s.rename(seat, body.name.as_deref().unwrap_or(""))?;
    Ok(Json(json!({"ok": true, "name": s.seats[seat].name})))
}

async fn start(State(sh): State<Shared>, Path(id): Path<String>, h: HeaderMap, q: Q) -> Result<Json<Value>, ApiError> {
    let mut g = sh.write().await;
    let s = session_mut(&mut g, &id)?;
    if !matches!(any_auth(s, &h, &q)?, Who::Host) {
        return err(StatusCode::FORBIDDEN, "host only");
    }
    s.start(&sh)?;
    Ok(Json(json!({"ok": true})))
}

/// Host: remove the player with join-order index `seat` (as in the player list).
async fn kick(State(sh): State<Shared>, Path((id, seat)): Path<(String, u32)>, h: HeaderMap, q: Q) -> Result<Json<Value>, ApiError> {
    let resolve = {
        let mut g = sh.write().await;
        let s = session_mut(&mut g, &id)?;
        if !matches!(any_auth(s, &h, &q)?, Who::Host) {
            return err(StatusCode::FORBIDDEN, "host only");
        }
        s.kick(seat)?
    };
    if let Some(n) = resolve {
        tokio::spawn(try_resolve(sh.clone(), id, n, false));
    }
    Ok(Json(json!({"ok": true})))
}

/// Host: let the player with join-order index `seat`, waiting for the next round, play in the open round now.
async fn admit(State(sh): State<Shared>, Path((id, seat)): Path<(String, u32)>, h: HeaderMap, q: Q) -> Result<Json<Value>, ApiError> {
    let mut g = sh.write().await;
    let s = session_mut(&mut g, &id)?;
    if !matches!(any_auth(s, &h, &q)?, Who::Host) {
        return err(StatusCode::FORBIDDEN, "host only");
    }
    s.admit(seat)?;
    Ok(Json(json!({"ok": true})))
}

async fn end(State(sh): State<Shared>, Path(id): Path<String>, h: HeaderMap, q: Q) -> Result<Json<Value>, ApiError> {
    let mut g = sh.write().await;
    let s = session_mut(&mut g, &id)?;
    if !matches!(any_auth(s, &h, &q)?, Who::Host) {
        return err(StatusCode::FORBIDDEN, "host only");
    }
    s.end()?;
    Ok(Json(json!({"ok": true})))
}

async fn get_state(State(sh): State<Shared>, Path(id): Path<String>, h: HeaderMap, q: Q) -> Result<Json<Value>, ApiError> {
    let g = sh.read().await;
    let s = session(&g, &id)?;
    let who = any_auth(s, &h, &q)?;
    let cur = s.current();
    let round = cur.map(|r| json!({"n": r.index, "state": r.state, "deadline": r.deadline_ms}));
    let latest_mix = s
        .rounds
        .iter()
        .rev()
        .find(|r| r.state == RoundState::Resolved)
        .map(|r| r.index);
    let you = match who {
        Who::Host => Value::Null,
        Who::Seat(i) => {
            let seat = &s.seats[i];
            let n = cur.map(|r| r.index).unwrap_or(0);
            let draft = cur.and_then(|r| r.orders.get(&seat.id));
            let orders = match (cur, draft) {
                (Some(r), Some(d)) if r.state == RoundState::Open => Some(d),
                (Some(r), _) if r.state == RoundState::Open => s.last_orders(seat.id, r.index),
                _ => s.last_orders(seat.id, n + 1),
            };
            json!({
                "name": seat.name,
                "joined_round": seat.joined_round,
                "seat_index": seat.index,
                "eligible": cur.map_or(true, |r| seat.joined_round <= r.index),
                "ready": cur.map_or(false, |r| r.ready.contains(&seat.id)),
                "orders": orders,
            })
        }
    };
    Ok(Json(json!({
        "config": s.config,
        "phase": s.phase,
        "round": round,
        "latest_mix": latest_mix,
        "seat_count": s.seat_count(),
        "ready_count": cur.map_or(0, |r| r.ready.len()),
        "eligible_count": cur.map_or(s.seat_count(), |r| s.eligible_count(r.index)),
        "players": s.players(),
        "song_ready": s.song.is_some(),
        "end_requested": s.end_requested,
        "you": you,
    })))
}

async fn put_orders(
    State(sh): State<Shared>,
    Path(id): Path<String>,
    h: HeaderMap,
    q: Q,
    Json(orders): Json<Orders>,
) -> Result<Response, ApiError> {
    let mut g = sh.write().await;
    let s = session_mut(&mut g, &id)?;
    let seat = seat_of(s, &h, &q)?;
    Ok(match s.put_orders(seat, orders)? {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(errors) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"ok": false, "errors": errors}))).into_response(),
    })
}

#[derive(Deserialize)]
struct BpmBody {
    bpm: f32,
}

/// Freeform sessions: change the tempo.
async fn set_bpm(
    State(sh): State<Shared>,
    Path(id): Path<String>,
    h: HeaderMap,
    q: Q,
    Json(body): Json<BpmBody>,
) -> Result<Json<Value>, ApiError> {
    let mut g = sh.write().await;
    let s = session_mut(&mut g, &id)?;
    seat_of(s, &h, &q)?;
    s.set_bpm(body.bpm)?;
    Ok(Json(json!({"ok": true, "bpm": s.config.bpm})))
}

#[derive(Deserialize)]
struct BarsBody {
    bars: u32,
}

/// Freeform sessions: change the length of the song.
async fn set_bars(
    State(sh): State<Shared>,
    Path(id): Path<String>,
    h: HeaderMap,
    q: Q,
    Json(body): Json<BarsBody>,
) -> Result<Json<Value>, ApiError> {
    let mut g = sh.write().await;
    let s = session_mut(&mut g, &id)?;
    seat_of(s, &h, &q)?;
    s.set_bars(body.bars)?;
    Ok(Json(json!({"ok": true, "bars": s.config.bars})))
}

#[derive(Deserialize)]
struct ReadyBody {
    ready: bool,
}

async fn ready(
    State(sh): State<Shared>,
    Path(id): Path<String>,
    h: HeaderMap,
    q: Q,
    Json(body): Json<ReadyBody>,
) -> Result<Json<Value>, ApiError> {
    let (resolve_n, n_all) = {
        let mut g = sh.write().await;
        let s = session_mut(&mut g, &id)?;
        let seat = seat_of(s, &h, &q)?;
        let all = s.set_ready(seat, body.ready)?;
        (s.current().map(|r| r.index), all)
    };
    if n_all {
        if let Some(n) = resolve_n {
            tokio::spawn(try_resolve(sh.clone(), id, n, false));
        }
    }
    Ok(Json(json!({"ok": true})))
}

/// Concurrent on-demand renders (downloads) allowed; extra requests get 429 so they cannot starve round renders.
static RENDER_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Render the caller's orders on their own as a song file to download: played once from silence, with the notes and
/// effects ringing out at the end (unlike a preview, which is a seamless loop). Shares the render slots.
async fn render_part(
    State(sh): State<Shared>,
    Path(id): Path<String>,
    h: HeaderMap,
    q: Q,
    Json(orders): Json<Orders>,
) -> Result<Response, ApiError> {
    let (cfg, seat_index) = {
        let g = sh.read().await;
        let s = session(&g, &id)?;
        let i = seat_of(s, &h, &q)?;
        let errors = orders.validate(&s.config.limits());
        if !errors.is_empty() {
            return Ok((StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"ok": false, "errors": errors}))).into_response());
        }
        (s.config.render_config(), s.seats[i].index)
    };
    let Ok(_permit) = RENDER_SLOTS.try_acquire() else {
        return err(StatusCode::TOO_MANY_REQUESTS, "the renderer is busy, try again in a moment");
    };
    let wav = tokio::task::spawn_blocking(move || render_part_song(&cfg, seat_index, &orders))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("render failed: {e}")))?;
    Ok(([(header::CONTENT_TYPE, "audio/wav"), (header::CACHE_CONTROL, "no-store")], wav).into_response())
}

/// Every round played so far, back to back, as a song file (the same render as the finished song). Shares the render slots.
async fn song_so_far(State(sh): State<Shared>, Path(id): Path<String>, h: HeaderMap, q: Q) -> Result<Response, ApiError> {
    let (cfg, rounds) = {
        let g = sh.read().await;
        let s = session(&g, &id)?;
        any_auth(s, &h, &q)?;
        (s.config.render_config(), played_rounds(s))
    };
    if rounds.is_empty() {
        return err(StatusCode::NOT_FOUND, "no round has been played yet");
    }
    let Ok(_permit) = RENDER_SLOTS.try_acquire() else {
        return err(StatusCode::TOO_MANY_REQUESTS, "the renderer is busy, try again in a moment");
    };
    let wav = tokio::task::spawn_blocking(move || render_rounds_song(&cfg, &rounds))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("render failed: {e}")))?;
    Ok(([(header::CONTENT_TYPE, "audio/wav"), (header::CACHE_CONTROL, "no-store")], wav).into_response())
}

fn wav_response(data: std::sync::Arc<[u8]>, filename: Option<&str>) -> Response {
    let mut r = (
        [
            (header::CONTENT_TYPE, "audio/wav".to_string()),
            (header::CACHE_CONTROL, "private, max-age=31536000, immutable".to_string()),
        ],
        data.to_vec(),
    )
        .into_response();
    if let Some(f) = filename {
        r.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{f}\"").parse().unwrap(),
        );
    }
    r
}

async fn mix(State(sh): State<Shared>, Path((id, n)): Path<(String, u32)>, h: HeaderMap, q: Q) -> Result<Response, ApiError> {
    let g = sh.read().await;
    let s = session(&g, &id)?;
    any_auth(s, &h, &q)?;
    match s.rounds.iter().find(|r| r.index == n).and_then(|r| r.mix.clone()) {
        Some(m) => Ok(wav_response(m, None)),
        None => err(StatusCode::NOT_FOUND, "round not resolved"),
    }
}

/// The parts played in a resolved round, each with its seat's join-order index (which seeds its noise): what its band
/// mix was rendered from. The browser's streaming player renders the band from these, with the listener's own draft in
/// place of their committed part. Nothing here is secret: every player hears the mix anyway.
async fn round_parts(State(sh): State<Shared>, Path((id, n)): Path<(String, u32)>, h: HeaderMap, q: Q) -> Result<Response, ApiError> {
    let g = sh.read().await;
    let s = session(&g, &id)?;
    any_auth(s, &h, &q)?;
    match s.rounds.iter().find(|r| r.index == n && r.state == RoundState::Resolved) {
        Some(r) => Ok(Json(r.played.iter().map(|(seat, orders)| json!({"seat": seat, "orders": orders})).collect::<Vec<_>>()).into_response()),
        None => err(StatusCode::NOT_FOUND, "round not resolved"),
    }
}

async fn song(State(sh): State<Shared>, Path(id): Path<String>, h: HeaderMap, q: Q) -> Result<Response, ApiError> {
    let g = sh.read().await;
    let s = session(&g, &id)?;
    any_auth(s, &h, &q)?;
    match &s.song {
        Some(w) => Ok(wav_response(w.clone(), q.get("download").map(|_| "song.wav"))),
        None => err(StatusCode::NOT_FOUND, "song not ready"),
    }
}

async fn events(
    State(sh): State<Shared>,
    Path(id): Path<String>,
    h: HeaderMap,
    q: Q,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let (rx, guard) = {
        let mut g = sh.write().await;
        let s = session_mut(&mut g, &id)?;
        let who = any_auth(s, &h, &q)?;
        let rx = s.tx.subscribe();
        // An open stream keeps the session from expiring, and a seat's shows the player as connected; the guard counts
        // it out when the stream ends.
        s.streams += 1;
        let seat = match who {
            Who::Seat(i) => {
                s.connected(i);
                Some(i)
            }
            Who::Host => None,
        };
        (rx, StreamGuard { shared: sh.clone(), sid: id.clone(), seat })
    };
    let stream = BroadcastStream::new(rx).filter_map(move |r| {
        let _alive = &guard; // the closure owns the guard, so it is dropped with the stream
        match r {
            Ok(ev) => Some(Ok(SseEvent::default().event(ev.name).data(ev.data.to_string()))),
            // Lagged: tell the client to resync.
            Err(_) => Some(Ok(SseEvent::default().event("resync").data("{}"))),
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

/// Lives as long as one event stream: when the browser goes away (the tab closes, the network drops: the keep-alives
/// stop getting through), the stream is dropped with it. The session has one stream fewer (its idle time starts when the
/// last one closes), and a seat one connection fewer: if that was the seat's last one and it is still not back after the
/// grace period, everyone is told the player has disconnected.
struct StreamGuard {
    shared: Shared,
    sid: String,
    seat: Option<usize>,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        let (shared, sid, seat) = (self.shared.clone(), std::mem::take(&mut self.sid), self.seat);
        rt.spawn(async move {
            let last = match shared.write().await.sessions.get_mut(&sid) {
                Some(s) => {
                    s.streams = s.streams.saturating_sub(1);
                    s.touch();
                    seat.filter(|&i| s.disconnected(i))
                }
                None => return,
            };
            if let Some(seat) = last {
                offline_check(shared, sid, seat).await;
            }
        });
    }
}

/// After the grace period: if the seat still has no event stream, tell everyone it has gone.
async fn offline_check(shared: Shared, sid: String, seat: usize) {
    tokio::time::sleep(OFFLINE_GRACE + std::time::Duration::from_millis(100)).await;
    if let Some(s) = shared.read().await.sessions.get(&sid) {
        if !s.seats[seat].online() {
            s.emit_players();
        }
    }
}
