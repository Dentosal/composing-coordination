//! Sessions, seats, rounds and the round state machine.

use crate::orders::{Limits, Orders, ValidationError};
use crate::render::{self, wav, RenderConfig, SeatPart};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

pub type SeatId = Uuid;
pub type Shared = Arc<RwLock<AppState>>;

#[derive(Default)]
pub struct AppState {
    pub sessions: HashMap<String, Session>,
}

pub const MAX_SESSIONS: usize = 200;

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

pub fn err<T>(status: StatusCode, msg: impl Into<String>) -> Result<T, ApiError> {
    Err(ApiError(status, msg.into()))
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub enum TimeoutPolicy {
    Wait,
    RepeatLast,
}

/// "Unlimited" tracks still have a ceiling: every track costs render time for the whole band.
pub const UNLIMITED_TRACK_CAP: usize = 64;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub bpm: f32,
    pub bars: u32,
    pub rows_per_bar: u32,
    pub max_lanes: u32,
    pub max_instruments: u32,
    /// Players may add and delete tracks themselves (up to `UNLIMITED_TRACK_CAP`); `max_lanes` / `max_instruments`
    /// are then only the number of tracks everyone starts with.
    pub unlimited_tracks: bool,
    pub rounds: Option<u32>,
    pub round_timer_secs: Option<u32>,
    pub timeout_policy: TimeoutPolicy,
    pub seed: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            bpm: 112.0,
            bars: 4,
            rows_per_bar: 16,
            max_lanes: 4,
            max_instruments: 4,
            unlimited_tracks: false,
            rounds: None,
            round_timer_secs: None,
            timeout_policy: TimeoutPolicy::Wait,
            seed: Uuid::new_v4().as_u128() as u64,
        }
    }
}

impl Config {
    pub fn validate(&self) -> Result<(), String> {
        let chk = |ok: bool, m: &str| if ok { Ok(()) } else { Err(m.to_string()) };
        chk(self.bpm.is_finite() && (40.0..=240.0).contains(&self.bpm), "bpm must be 40..=240")?;
        chk((1..=16).contains(&self.bars), "bars must be 1..=16")?;
        chk(
            (4..=32).contains(&self.rows_per_bar) && self.rows_per_bar % 4 == 0,
            "rows_per_bar must be a multiple of 4 within 4..=32",
        )?;
        chk((1..=16).contains(&self.max_lanes), "max_lanes must be 1..=16")?;
        chk((1..=16).contains(&self.max_instruments), "max_instruments must be 1..=16")?;
        chk(self.rounds.map_or(true, |r| (1..=500).contains(&r)), "rounds must be 1..=500")?;
        chk(
            self.round_timer_secs.map_or(true, |t| (5..=86400).contains(&t)),
            "round_timer_secs must be 5..=86400",
        )?;
        Ok(())
    }

    pub fn render_config(&self) -> RenderConfig {
        RenderConfig { bpm: self.bpm, bars: self.bars, rows_per_bar: self.rows_per_bar, seed: self.seed }
    }

    pub fn limits(&self) -> Limits {
        let (max_lanes, max_instruments) = if self.unlimited_tracks {
            (UNLIMITED_TRACK_CAP, UNLIMITED_TRACK_CAP)
        } else {
            (self.max_lanes as usize, self.max_instruments as usize)
        };
        Limits { max_lanes, max_instruments, total_rows: self.bars * self.rows_per_bar }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub enum SeatKind {
    Human,
    #[allow(dead_code)]
    Bot,
}

#[derive(Clone, Debug)]
pub struct Seat {
    pub id: SeatId,
    pub token: Uuid,
    pub kind: SeatKind,
    pub joined_round: u32,
    /// Join order; part of the render PRNG key. Never sent to clients.
    pub index: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RoundState {
    Open,
    Rendering,
    Resolved,
}

pub struct Round {
    pub index: u32,
    pub state: RoundState,
    pub deadline: Option<Instant>,
    pub deadline_ms: Option<u64>,
    pub orders: HashMap<SeatId, Orders>,
    pub ready: HashSet<SeatId>,
    pub mix: Option<Arc<[u8]>>,
    /// Orders actually rendered, with seat index (set when the round leaves Open).
    pub played: Vec<(u32, Orders)>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Lobby,
    Running,
    Ended,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub name: &'static str,
    pub data: Value,
}

pub struct Session {
    pub id: String,
    pub config: Config,
    pub host_token: Uuid,
    pub seats: Vec<Seat>,
    pub phase: Phase,
    pub rounds: Vec<Round>,
    pub end_requested: bool,
    pub tx: broadcast::Sender<Event>,
    pub song: Option<Arc<[u8]>>,
}

pub enum Who {
    Seat(usize),
    Host,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Session {
    pub fn new(config: Config) -> Self {
        let (tx, _) = broadcast::channel(64);
        Session {
            id: Uuid::new_v4().simple().to_string()[..10].to_string(),
            config,
            host_token: Uuid::new_v4(),
            seats: Vec::new(),
            phase: Phase::Lobby,
            rounds: Vec::new(),
            end_requested: false,
            tx,
            song: None,
        }
    }

    pub fn emit(&self, name: &'static str, data: Value) {
        let _ = self.tx.send(Event { name, data });
    }

    pub fn auth(&self, token: Uuid) -> Option<Who> {
        if token == self.host_token {
            return Some(Who::Host);
        }
        self.seats.iter().position(|s| s.token == token).map(Who::Seat)
    }

    pub fn current(&self) -> Option<&Round> {
        self.rounds.last()
    }

    pub fn eligible_count(&self, n: u32) -> usize {
        self.seats.iter().filter(|s| s.joined_round <= n).count()
    }

    pub fn emit_seat_count(&self) {
        self.emit("seat_count", json!({"count": self.seats.len()}));
    }

    pub fn emit_ready_count(&self) {
        if let Some(r) = self.current() {
            self.emit("ready_count", json!({"ready": r.ready.len(), "total": self.eligible_count(r.index)}));
        }
    }

    pub fn join(&mut self) -> Result<Uuid, ApiError> {
        if self.phase == Phase::Ended {
            return err(StatusCode::CONFLICT, "session has ended");
        }
        let joined_round = match self.phase {
            Phase::Lobby => 1,
            _ => self.current().map(|r| r.index + 1).unwrap_or(1),
        };
        let seat = Seat {
            id: Uuid::new_v4(),
            token: Uuid::new_v4(),
            kind: SeatKind::Human,
            joined_round,
            index: self.seats.len() as u32,
        };
        let token = seat.token;
        self.seats.push(seat);
        self.emit_seat_count();
        Ok(token)
    }

    /// The orders a seat last had in effect before round `n`.
    pub fn last_orders(&self, seat: SeatId, before: u32) -> Option<&Orders> {
        self.rounds
            .iter()
            .rev()
            .filter(|r| r.index < before)
            .find_map(|r| r.orders.get(&seat))
    }

    pub fn open_round(&mut self, n: u32, shared: &Shared) {
        let (deadline, deadline_ms) = match self.config.round_timer_secs {
            Some(s) => (Some(Instant::now() + Duration::from_secs(s as u64)), Some(now_ms() + s as u64 * 1000)),
            None => (None, None),
        };
        self.rounds.push(Round {
            index: n,
            state: RoundState::Open,
            deadline,
            deadline_ms,
            orders: HashMap::new(),
            ready: HashSet::new(),
            mix: None,
            played: Vec::new(),
        });
        self.phase = Phase::Running;
        self.emit("round_opened", json!({"n": n, "deadline": deadline_ms}));
        self.emit_ready_count();
        if let Some(d) = deadline {
            let shared = shared.clone();
            let sid = self.id.clone();
            tokio::spawn(async move {
                tokio::time::sleep_until(d.into()).await;
                try_resolve(shared, sid, n, true).await;
            });
        }
    }

    pub fn start(&mut self, shared: &Shared) -> Result<(), ApiError> {
        if self.phase != Phase::Lobby {
            return err(StatusCode::CONFLICT, "session already started");
        }
        if self.seats.is_empty() {
            return err(StatusCode::CONFLICT, "need at least one seat");
        }
        self.open_round(1, shared);
        Ok(())
    }

    pub fn end(&mut self) -> Result<(), ApiError> {
        match self.phase {
            Phase::Ended => err(StatusCode::CONFLICT, "session already ended"),
            Phase::Lobby => {
                self.phase = Phase::Ended;
                self.emit("session_ended", json!({}));
                Ok(())
            }
            Phase::Running => {
                self.end_requested = true;
                Ok(())
            }
        }
    }

    fn open_round_mut(&mut self, seat_idx: usize) -> Result<&mut Round, ApiError> {
        let joined = self.seats[seat_idx].joined_round;
        match self.rounds.last_mut() {
            Some(r) if r.state == RoundState::Open => {
                if joined > r.index {
                    err(StatusCode::CONFLICT, "you join in the next round")
                } else {
                    Ok(r)
                }
            }
            _ => err(StatusCode::CONFLICT, "no open round"),
        }
    }

    pub fn put_orders(&mut self, seat_idx: usize, orders: Orders) -> Result<Result<(), Vec<ValidationError>>, ApiError> {
        let limits = self.config.limits();
        let id = self.seats[seat_idx].id;
        let errs = orders.validate(&limits);
        let round = self.open_round_mut(seat_idx)?;
        if !errs.is_empty() {
            return Ok(Err(errs));
        }
        round.orders.insert(id, orders);
        let was_ready = round.ready.remove(&id);
        if was_ready {
            self.emit_ready_count();
        }
        Ok(Ok(()))
    }

    /// Returns true when the round should now resolve.
    pub fn set_ready(&mut self, seat_idx: usize, ready: bool) -> Result<bool, ApiError> {
        let id = self.seats[seat_idx].id;
        let round = self.open_round_mut(seat_idx)?;
        let changed = if ready { round.ready.insert(id) } else { round.ready.remove(&id) };
        let n = round.index;
        if changed {
            self.emit_ready_count();
        }
        Ok(self.all_ready(n))
    }

    fn all_ready(&self, n: u32) -> bool {
        let Some(r) = self.rounds.last() else { return false };
        if r.index != n || r.state != RoundState::Open {
            return false;
        }
        let eligible: Vec<_> = self.seats.iter().filter(|s| s.joined_round <= n).collect();
        !eligible.is_empty() && eligible.iter().all(|s| r.ready.contains(&s.id))
    }

    /// Phase one of resolving: decide, fill in missing orders, flip to Rendering.
    fn begin_resolve(&mut self, n: u32, timer: bool) -> Option<RenderJob> {
        let ok = if timer {
            // Timer expiry only resolves under RepeatLast; under Wait the round keeps waiting.
            let open = matches!(self.rounds.last(), Some(r) if r.index == n && r.state == RoundState::Open);
            open && self.config.timeout_policy == TimeoutPolicy::RepeatLast && self.eligible_count(n) > 0
        } else {
            self.all_ready(n)
        };
        if !ok {
            return None;
        }
        let eligible: Vec<Seat> = self.seats.iter().filter(|s| s.joined_round <= n).cloned().collect();
        let mut filled: Vec<(SeatId, Orders)> = Vec::new();
        {
            let round = self.rounds.last().unwrap();
            for s in &eligible {
                let o = round
                    .orders
                    .get(&s.id)
                    .cloned()
                    .or_else(|| self.last_orders(s.id, n).cloned())
                    .unwrap_or_default();
                filled.push((s.id, o));
            }
        }
        let round = self.rounds.last_mut().unwrap();
        round.state = RoundState::Rendering;
        for (id, o) in filled {
            round.orders.insert(id, o);
        }
        round.played = eligible
            .iter()
            .map(|s| (s.index, round.orders[&s.id].clone()))
            .collect();
        Some(RenderJob { cfg: self.config.render_config(), parts: round.played.clone() })
    }

    fn finish_resolve(&mut self, n: u32, wav: Arc<[u8]>, shared: &Shared) {
        let Some(round) = self.rounds.last_mut() else { return };
        if round.index != n {
            return;
        }
        round.mix = Some(wav);
        round.state = RoundState::Resolved;
        self.emit("round_resolved", json!({"n": n}));
        let done = self.end_requested || self.config.rounds.is_some_and(|r| n >= r);
        if done {
            self.phase = Phase::Ended;
            self.emit("session_ended", json!({}));
            let shared = shared.clone();
            let sid = self.id.clone();
            tokio::spawn(render_song(shared, sid));
        } else {
            self.open_round(n + 1, shared);
        }
    }
}

struct RenderJob {
    cfg: RenderConfig,
    parts: Vec<(u32, Orders)>,
}

fn render_mix(job: RenderJob) -> Arc<[u8]> {
    let parts: Vec<SeatPart> = job.parts.iter().map(|(i, o)| SeatPart { seat_index: *i, orders: o }).collect();
    let stereo = render::render(&job.cfg, &[parts.clone(), parts], 1);
    Arc::from(wav::encode(&stereo))
}

/// One seat's orders alone, as a seamless loop (same two-pass render as a round mix).
pub fn render_preview(cfg: &RenderConfig, seat_index: u32, orders: &Orders) -> Vec<u8> {
    let parts = vec![SeatPart { seat_index, orders }];
    wav::encode(&render::render(cfg, &[parts.clone(), parts], 1))
}

/// Resolve round `n` if its conditions hold. Safe to call redundantly.
pub async fn try_resolve(shared: Shared, sid: String, n: u32, timer: bool) {
    let job = {
        let mut g = shared.write().await;
        let Some(s) = g.sessions.get_mut(&sid) else { return };
        s.begin_resolve(n, timer)
    };
    let Some(job) = job else { return };
    let wav = match tokio::task::spawn_blocking(move || render_mix(job)).await {
        Ok(w) => w,
        Err(e) => {
            eprintln!("render failed: {e}");
            return;
        }
    };
    let mut g = shared.write().await;
    if let Some(s) = g.sessions.get_mut(&sid) {
        s.finish_resolve(n, wav, &shared);
    }
}

async fn render_song(shared: Shared, sid: String) {
    let job = {
        let g = shared.read().await;
        let Some(s) = g.sessions.get(&sid) else { return };
        let rounds: Vec<Vec<(u32, Orders)>> =
            s.rounds.iter().filter(|r| r.state == RoundState::Resolved).map(|r| r.played.clone()).collect();
        (s.config.render_config(), rounds)
    };
    if job.1.is_empty() {
        return;
    }
    let wav = tokio::task::spawn_blocking(move || {
        let loops: Vec<Vec<SeatPart>> = job
            .1
            .iter()
            .map(|r| r.iter().map(|(i, o)| SeatPart { seat_index: *i, orders: o }).collect())
            .collect();
        Arc::<[u8]>::from(wav::encode(&render::render(&job.0, &loops, 0)))
    })
    .await;
    if let Ok(w) = wav {
        let mut g = shared.write().await;
        if let Some(s) = g.sessions.get_mut(&sid) {
            s.song = Some(w);
            s.emit("song_ready", json!({}));
        }
    }
}
