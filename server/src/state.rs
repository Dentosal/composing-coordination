//! Sessions, seats, rounds and the round state machine.

use crate::orders::{Instrument, Limits, Orders, ValidationError};
use crate::render::{self, wav, RenderConfig, SeatPart};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
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
/// A session nobody has had open (no event stream) and nobody has used for this long is removed, with its rounds and
/// audio. An ended game's song can be downloaded until then.
pub const IDLE_EXPIRY: Duration = Duration::from_secs(60 * 60);
/// How often the sweeper looks for idle sessions.
pub const SWEEP_EVERY: Duration = Duration::from_secs(60);

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

/// A freeform session can make its loop longer than a game's 16 bars, up to this many.
pub const MAX_FREEFORM_BARS: u32 = 256;
/// Every session has this many rows per bar (16ths in 4/4). `Config::rows_per_bar` stays in the JSON, fixed at this.
pub const ROWS_PER_BAR: u32 = 16;
pub const MIN_BPM: f32 = 40.0;
pub const MAX_BPM: f32 = 240.0;

/// "Unlimited" tracks still have a ceiling: every track costs render time for the whole band.
pub const UNLIMITED_TRACK_CAP: usize = 64;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub bpm: f32,
    pub bars: u32,
    /// Always `ROWS_PER_BAR`: a request may leave it out, or send that value.
    pub rows_per_bar: u32,
    pub max_lanes: u32,
    pub max_instruments: u32,
    /// Sounds per player for the whole game (absent: twice the tracks per player). A sound is an instrument as set up
    /// (see `sound_key`); every one a player has played in a round counts, and reusing one is free. The game's combined
    /// scene file needs a track for each, so this keeps it within `UNLIMITED_TRACK_CAP` tracks.
    pub max_sounds: Option<u32>,
    /// Attempts at each round of a game: after every attempt but the last, the players vote (anonymously) whether to
    /// keep it, and a single no plays the round again. The first round has one more attempt: it is written blind.
    pub attempts: u32,
    /// Players may add and delete tracks themselves (up to `UNLIMITED_TRACK_CAP`); `max_lanes` / `max_instruments`
    /// are then only the number of tracks everyone starts with.
    pub unlimited_tracks: bool,
    /// Freeform mode: a single user, no game. One seat, no rounds to commit; tracks are unlimited.
    pub freeform: bool,
    pub rounds: Option<u32>,
    pub round_timer_secs: Option<u32>,
    pub timeout_policy: TimeoutPolicy,
    /// Drives the seeded noise and reverb. Random seeds exceed what a JSON number holds exactly in a browser (2^53), so
    /// it is sent as a string; a number is still accepted when creating a session.
    #[serde(with = "seed_json")]
    pub seed: u64,
}

mod seed_json {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Seed {
            Number(u64),
            Text(String),
        }
        match Seed::deserialize(d)? {
            Seed::Number(n) => Ok(n),
            Seed::Text(t) => t.trim().parse().map_err(|_| serde::de::Error::custom("seed must be a whole number (0 to 18446744073709551615)")),
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            bpm: 112.0,
            bars: 4,
            rows_per_bar: ROWS_PER_BAR,
            max_lanes: 4,
            max_instruments: 4,
            max_sounds: None,
            attempts: 2,
            unlimited_tracks: false,
            freeform: false,
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
        chk(self.bpm.is_finite() && (MIN_BPM..=MAX_BPM).contains(&self.bpm), "bpm must be 40..=240")?;
        let max_bars = if self.freeform { MAX_FREEFORM_BARS } else { 16 };
        chk((1..=max_bars).contains(&self.bars), &format!("bars must be 1..={max_bars}"))?;
        chk(self.rows_per_bar == ROWS_PER_BAR, &format!("rows_per_bar is fixed at {ROWS_PER_BAR}"))?;
        chk((1..=16).contains(&self.max_lanes), "max_lanes must be 1..=16")?;
        chk((1..=16).contains(&self.max_instruments), "max_instruments must be 1..=16")?;
        let cap = UNLIMITED_TRACK_CAP as u32;
        chk(self.max_sounds.map_or(true, |s| (1..=cap).contains(&s)), &format!("max_sounds must be 1..={cap}"))?;
        chk((1..=10).contains(&self.attempts), "attempts must be 1..=10")?;
        chk(
            self.unlimited_tracks || self.sound_budget() >= self.max_lanes.min(self.max_instruments),
            "max_sounds must be at least the tracks per player",
        )?;
        if !self.freeform {
            let most = self.max_rounds();
            chk(self.rounds.map_or(true, |r| (1..=most).contains(&r)), &format!(
                "rounds must be 1..={most}: a game is at most {MAX_FREEFORM_BARS} bars, so that its scene opens in the editor"))?;
        }
        chk(
            self.round_timer_secs.map_or(true, |t| (5..=86400).contains(&t)),
            "round_timer_secs must be 5..=86400",
        )?;
        Ok(())
    }

    /// The most rounds a game can have: the whole song is at most `MAX_FREEFORM_BARS` bars, so that its combined scene
    /// opens in the freeform editor. A game without a set number of rounds ends there.
    pub fn max_rounds(&self) -> u32 {
        MAX_FREEFORM_BARS / self.bars.max(1)
    }

    /// Attempts at round `slot` of the song (1-based): the first round has one more.
    pub fn attempts_at(&self, slot: u32) -> u32 {
        self.attempts + u32::from(slot == 1)
    }

    /// Sounds per player for the whole game.
    pub fn sound_budget(&self) -> u32 {
        self.max_sounds.unwrap_or(2 * self.max_lanes.min(self.max_instruments)).min(UNLIMITED_TRACK_CAP as u32)
    }

    /// The most players a game takes: everyone's sounds together must fit in the combined scene's tracks.
    pub fn max_players(&self) -> usize {
        (UNLIMITED_TRACK_CAP as u32 / self.sound_budget().max(1)) as usize
    }

    pub fn render_config(&self) -> RenderConfig {
        RenderConfig { bpm: self.bpm, bars: self.bars, rows_per_bar: self.rows_per_bar, seed: self.seed }
    }

    pub fn limits(&self) -> Limits {
        let (max_lanes, max_instruments) = if self.unlimited_tracks || self.freeform {
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
    /// Join order; part of the render PRNG key.
    pub index: u32,
    /// The player's nickname, shown to the others (see `clean_name`).
    pub name: String,
    /// Open event streams (browser tabs) of this seat. With none for longer than `OFFLINE_GRACE` the player shows as
    /// disconnected.
    pub connections: u32,
    /// Removed by the host: the token no longer works and the seat plays no more rounds. The seat stays in the list so
    /// the others keep their join-order index (which seeds their noise); its earlier rounds stay in the song.
    pub kicked: bool,
    /// Since when the seat has had no event stream (None: connected now). Joining starts it: the page has until the
    /// grace period ends to connect.
    pub left_at: Option<Instant>,
}

/// How long a seat may have no event stream before it shows as disconnected: a page reload or a brief network hiccup
/// reconnects well within this.
pub const OFFLINE_GRACE: Duration = Duration::from_secs(5);

impl Seat {
    /// Whether this seat plays in round `n`.
    pub fn plays_in(&self, n: u32) -> bool {
        !self.kicked && self.joined_round <= n
    }

    /// Whether the player counts as here: a tab is open, or the last one closed (or the seat was taken) only moments ago.
    pub fn online(&self) -> bool {
        self.connections > 0 || self.left_at.map_or(true, |t| t.elapsed() < OFFLINE_GRACE)
    }
}

pub const MAX_NAME_CHARS: usize = 24;

/// A nickname as stored: trimmed, runs of whitespace made one space, 1..=`MAX_NAME_CHARS` characters, no control characters.
pub fn clean_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "the nickname is empty");
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return err(StatusCode::UNPROCESSABLE_ENTITY, format!("the nickname is longer than {MAX_NAME_CHARS} characters"));
    }
    if name.chars().any(char::is_control) {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "the nickname has control characters");
    }
    Ok(name)
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
    /// Which round of the song this is (1-based; `index` counts attempts too) and which attempt at it.
    pub slot: u32,
    pub attempt: u32,
    /// While the players vote on keeping this attempt: each one's vote so far (secret: only counts are told).
    pub votes: Option<HashMap<SeatId, bool>>,
    /// Voted down: not in the song (another attempt at its slot follows).
    pub rejected: bool,
}

impl Round {
    /// Played and not voted down: part of the song (or up for a vote on it).
    pub fn in_song(&self) -> bool {
        self.state == RoundState::Resolved && !self.rejected
    }
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
    /// Open event streams, any token (a seat's or the host's).
    pub streams: u32,
    /// When the session was last used (`now_ms`): any request to it, or an event stream opening or closing. Atomic so
    /// requests holding only the read lock can mark it.
    pub last_active: AtomicU64,
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
            streams: 0,
            last_active: AtomicU64::new(now_ms()),
        }
    }

    /// Mark the session as in use now.
    pub fn touch(&self) {
        self.last_active.store(now_ms(), Ordering::Relaxed);
    }

    /// Whether the session can be removed at time `now` (`now_ms`): nobody has it open and it has been idle for
    /// `IDLE_EXPIRY`.
    pub fn expired(&self, now: u64) -> bool {
        self.streams == 0 && now.saturating_sub(self.last_active.load(Ordering::Relaxed)) >= IDLE_EXPIRY.as_millis() as u64
    }

    pub fn emit(&self, name: &'static str, data: Value) {
        let _ = self.tx.send(Event { name, data });
    }

    pub fn auth(&self, token: Uuid) -> Option<Who> {
        if token == self.host_token {
            return Some(Who::Host);
        }
        self.seats.iter().position(|s| s.token == token && !s.kicked).map(Who::Seat)
    }

    pub fn current(&self) -> Option<&Round> {
        self.rounds.last()
    }

    pub fn eligible_count(&self, n: u32) -> usize {
        self.seats.iter().filter(|s| s.plays_in(n)).count()
    }

    /// Seats taken, not counting kicked players.
    pub fn seat_count(&self) -> usize {
        self.seats.iter().filter(|s| !s.kicked).count()
    }

    pub fn emit_seat_count(&self) {
        self.emit("seat_count", json!({"count": self.seat_count()}));
        self.emit_players();
    }

    pub fn emit_ready_count(&self) {
        if let Some(r) = self.current() {
            self.emit("ready_count", json!({"ready": r.ready.len(), "total": self.eligible_count(r.index)}));
        }
        self.emit_players();
    }

    /// Everyone seated, in join order: `[{seat, name, ready, eligible}]`. `seat` is the join-order index (what the band's
    /// parts and `you.seat_index` carry); `ready` and `eligible` are about the current round (false and true in the lobby).
    pub fn players(&self) -> Value {
        let cur = self.current();
        Value::Array(self.seats.iter().filter(|s| !s.kicked).map(|s| json!({
            "seat": s.index,
            "name": s.name,
            "ready": cur.map_or(false, |r| r.ready.contains(&s.id)),
            "eligible": cur.map_or(true, |r| s.plays_in(r.index)),
            "online": s.online(),
        })).collect())
    }

    /// A seat's event stream opened. Tells everyone if that brings the player back.
    pub fn connected(&mut self, seat_idx: usize) {
        let seat = &mut self.seats[seat_idx];
        let was = seat.online();
        seat.connections += 1;
        seat.left_at = None;
        if !was {
            self.emit_players();
        }
    }

    /// A seat's event stream closed. Returns true when it was the last one: the caller checks again after
    /// `OFFLINE_GRACE` (see `offline_check`) and tells everyone if the player is still gone.
    pub fn disconnected(&mut self, seat_idx: usize) -> bool {
        let seat = &mut self.seats[seat_idx];
        seat.connections = seat.connections.saturating_sub(1);
        if seat.connections == 0 {
            seat.left_at = Some(Instant::now());
        }
        seat.connections == 0
    }

    pub fn emit_players(&self) {
        self.emit("players", json!({"players": self.players()}));
    }

    /// Change a seat's nickname.
    pub fn rename(&mut self, seat_idx: usize, name: &str) -> Result<(), ApiError> {
        self.seats[seat_idx].name = clean_name(name)?;
        self.emit_players();
        Ok(())
    }

    pub fn join(&mut self) -> Result<Uuid, ApiError> {
        self.join_as(None)
    }

    /// Take a seat under a nickname (none: "Player N", N counting from 1 in join order).
    pub fn join_as(&mut self, name: Option<&str>) -> Result<Uuid, ApiError> {
        let name = match name {
            Some(n) => clean_name(n)?,
            None => format!("Player {}", self.seats.len() + 1),
        };
        if self.phase == Phase::Ended {
            return err(StatusCode::CONFLICT, "session has ended");
        }
        if self.config.freeform && !self.seats.is_empty() {
            return err(StatusCode::CONFLICT, "a freeform session is for one person only");
        }
        // Kicked seats count too: their rounds stay in the song.
        if !self.config.freeform && self.seats.len() >= self.config.max_players() {
            return err(StatusCode::CONFLICT, format!(
                "the session is full: {} players with {} sounds each fill the song's {UNLIMITED_TRACK_CAP} tracks",
                self.config.max_players(), self.config.sound_budget()));
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
            name,
            connections: 0,
            kicked: false,
            left_at: Some(Instant::now()),
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
        // The next round of the song, or another attempt at the one just voted down.
        let (slot, attempt) = match self.rounds.last() {
            None => (1, 1),
            Some(r) if r.rejected => (r.slot, r.attempt + 1),
            Some(r) => (r.slot + 1, 1),
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
            slot,
            attempt,
            votes: None,
            rejected: false,
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

    /// Freeform sessions only: make the song longer or shorter (nobody else is waiting on it). Shortening drops the
    /// notes and effects past the new end from every stored draft.
    pub fn set_bars(&mut self, bars: u32) -> Result<(), ApiError> {
        if !self.config.freeform {
            return err(StatusCode::CONFLICT, "only a freeform session can change its length");
        }
        if !(1..=MAX_FREEFORM_BARS).contains(&bars) {
            return err(StatusCode::UNPROCESSABLE_ENTITY, format!("bars must be 1..={MAX_FREEFORM_BARS}"));
        }
        self.config.bars = bars;
        let total = bars * self.config.rows_per_bar;
        for round in &mut self.rounds {
            for orders in round.orders.values_mut() {
                orders.truncate_rows(total);
            }
        }
        self.emit_config();
        Ok(())
    }

    /// Freeform sessions only: change the tempo.
    pub fn set_bpm(&mut self, bpm: f32) -> Result<(), ApiError> {
        if !self.config.freeform {
            return err(StatusCode::CONFLICT, "only a freeform session can change its tempo");
        }
        if !(bpm.is_finite() && (MIN_BPM..=MAX_BPM).contains(&bpm)) {
            return err(StatusCode::UNPROCESSABLE_ENTITY, format!("bpm must be {MIN_BPM}..={MAX_BPM}"));
        }
        self.config.bpm = bpm;
        self.emit_config();
        Ok(())
    }

    /// The settings a freeform session can change: its length and tempo.
    fn emit_config(&self) {
        self.emit("config", json!({"bars": self.config.bars, "bpm": self.config.bpm}));
    }

    /// The seat with join-order index `seat`, unless it has been kicked.
    fn active_seat(&self, seat: u32) -> Result<usize, ApiError> {
        match self.seats.get(seat as usize) {
            Some(s) if !s.kicked => Ok(seat as usize),
            _ => err(StatusCode::NOT_FOUND, "no such player"),
        }
    }

    /// The host removes a player: their token stops working, their draft for the open round is dropped and they play
    /// no more rounds. Returns the open round's index when everyone left is now ready (the caller resolves it).
    pub fn kick(&mut self, seat: u32, shared: &Shared) -> Result<Option<u32>, ApiError> {
        if self.config.freeform {
            return err(StatusCode::CONFLICT, "a freeform session has nobody to remove");
        }
        let i = self.active_seat(seat)?;
        let id = self.seats[i].id;
        self.seats[i].kicked = true;
        let mut open = None;
        if let Some(r) = self.rounds.last_mut() {
            if r.state == RoundState::Open {
                r.orders.remove(&id);
                r.ready.remove(&id);
                open = Some(r.index);
            }
        }
        self.emit_seat_count();
        self.emit_ready_count();
        self.count_votes(shared); // a vote may now be complete without them
        Ok(open.filter(|&n| self.all_ready(n)))
    }

    /// Who votes on round `r`: the players who played in it and are still here.
    fn voters(&self, r: &Round) -> Vec<SeatId> {
        self.seats.iter().filter(|s| s.plays_in(r.index)).map(|s| s.id).collect()
    }

    /// The vote on the last round, if one is going on: `(cast, total)`. Only counts: the votes are secret.
    pub fn vote_count(&self) -> Option<(usize, usize)> {
        let r = self.rounds.last()?;
        let votes = r.votes.as_ref()?;
        let voters = self.voters(r);
        Some((voters.iter().filter(|id| votes.contains_key(id)).count(), voters.len()))
    }

    /// A player votes to keep the round just played (`keep`) or to play it again. A vote can be changed until the last
    /// one is in; then the round is kept if every vote is yes, else played again.
    pub fn vote(&mut self, seat_idx: usize, keep: bool, shared: &Shared) -> Result<(), ApiError> {
        let id = self.seats[seat_idx].id;
        let Some(r) = self.rounds.last() else { return err(StatusCode::CONFLICT, "nothing to vote on") };
        if r.votes.is_none() {
            return err(StatusCode::CONFLICT, "nothing to vote on");
        }
        if !self.voters(r).contains(&id) {
            return err(StatusCode::CONFLICT, "you did not play in this round");
        }
        self.rounds.last_mut().unwrap().votes.as_mut().unwrap().insert(id, keep);
        self.count_votes(shared);
        Ok(())
    }

    /// Tell everyone how many have voted; when everyone has, decide: keep the round or play it again.
    fn count_votes(&mut self, shared: &Shared) {
        let Some((cast, total)) = self.vote_count() else { return };
        let r = self.rounds.last().unwrap();
        self.emit("votes", json!({"n": r.index, "cast": cast, "total": total}));
        if cast < total {
            return;
        }
        let voters = self.voters(r);
        let votes = r.votes.as_ref().unwrap();
        let keep = voters.iter().all(|id| votes.get(id) == Some(&true));
        let n = r.index;
        let r = self.rounds.last_mut().unwrap();
        r.votes = None;
        r.rejected = !keep;
        self.emit("vote_result", json!({"n": n, "kept": keep}));
        if keep {
            self.keep_round(n, shared);
        } else {
            self.open_round(n + 1, shared);
        }
    }

    /// Round `n` is in the song: end the game when that was the last round, else open the next one.
    fn keep_round(&mut self, n: u32, shared: &Shared) {
        let slot = self.rounds.last().map_or(1, |r| r.slot);
        let done = self.end_requested || slot >= self.config.rounds.unwrap_or(self.config.max_rounds());
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

    /// The host lets a player who would join next round play in the open round already.
    pub fn admit(&mut self, seat: u32) -> Result<(), ApiError> {
        let i = self.active_seat(seat)?;
        let n = match self.rounds.last() {
            Some(r) if r.state == RoundState::Open => r.index,
            _ => return err(StatusCode::CONFLICT, "no open round to join"),
        };
        if self.seats[i].joined_round <= n {
            return err(StatusCode::CONFLICT, "the player is already in this round");
        }
        self.seats[i].joined_round = n;
        self.emit_ready_count();
        Ok(())
    }

    /// The sounds seat `seat_idx` has used in the rounds played before round `n`, plus those of `draft`: how many
    /// different ones (see `part_sounds`).
    pub fn sounds_used(&self, seat_idx: usize, n: u32, draft: Option<&Orders>) -> usize {
        let seat = self.seats[seat_idx].index;
        let mut keys = HashSet::new();
        for r in self.rounds.iter().filter(|r| r.in_song() && r.index < n) {
            for (_, o) in r.played.iter().filter(|(s, _)| *s == seat) {
                keys.extend(part_sounds(o));
            }
        }
        if let Some(d) = draft {
            keys.extend(part_sounds(d));
        }
        keys.len()
    }

    /// The sounds seat `seat_idx` has played in the song (rounds kept, or up for a vote), one entry per sound: the
    /// instrument as it was last played (so loading it again is the same sound: free) and the rounds of the song it was
    /// in, and the track (1-based) it was last on, to name it by when it has no name. `[{instrument, slots, track}]`, in
    /// the order first played.
    pub fn sound_list(&self, seat_idx: usize) -> Value {
        let seat = self.seats[seat_idx].index;
        let mut list: Vec<(String, Instrument, Vec<u32>, usize)> = Vec::new();
        for r in self.rounds.iter().filter(|r| r.in_song()) {
            for (_, o) in r.played.iter().filter(|(s, _)| *s == seat) {
                for (t, lane) in o.lanes.iter().enumerate().filter(|(_, l)| l.steps.iter().any(|s| s.note.is_some())) {
                    let Some(inst) = o.instruments.iter().find(|i| i.id == lane.instrument) else { continue };
                    let key = sound_key(inst);
                    match list.iter_mut().find(|(k, ..)| *k == key) {
                        Some((_, i, slots, track)) => {
                            *i = inst.clone();
                            *track = t + 1;
                            if !slots.contains(&r.slot) {
                                slots.push(r.slot);
                            }
                        }
                        None => list.push((key, inst.clone(), vec![r.slot], t + 1)),
                    }
                }
            }
        }
        Value::Array(list.into_iter().map(|(_, i, slots, track)| json!({"instrument": i, "slots": slots, "track": track})).collect())
    }

    /// The orders seat `seat_idx` has in effect now: its draft for the open round, or else its last part.
    fn orders_in_effect(&self, seat_idx: usize) -> (u32, Option<&Orders>) {
        let id = self.seats[seat_idx].id;
        let n = self.current().map_or(1, |r| r.index);
        (n, self.current().and_then(|r| r.orders.get(&id)).or_else(|| self.last_orders(id, n)))
    }

    /// `{used, budget}`: seat `seat_idx`'s sounds in this game, counting the orders it has in effect now.
    pub fn sounds_json(&self, seat_idx: usize) -> Value {
        let (n, orders) = self.orders_in_effect(seat_idx);
        json!({"used": self.sounds_used(seat_idx, n, orders), "budget": self.config.sound_budget()})
    }

    /// Returns true when the round should now resolve.
    pub fn set_ready(&mut self, seat_idx: usize, ready: bool) -> Result<bool, ApiError> {
        let id = self.seats[seat_idx].id;
        if ready && !self.config.freeform {
            let (n, orders) = self.orders_in_effect(seat_idx);
            let (used, budget) = (self.sounds_used(seat_idx, n, orders), self.config.sound_budget() as usize);
            if used > budget {
                return err(StatusCode::UNPROCESSABLE_ENTITY, format!(
                    "your part makes it {used} sounds in this game, and each player has {budget}: reuse sounds \
                     (an earlier round's cost nothing more)"));
            }
        }
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
        let eligible: Vec<_> = self.seats.iter().filter(|s| s.plays_in(n)).collect();
        !eligible.is_empty() && eligible.iter().all(|s| r.ready.contains(&s.id))
    }

    /// Phase one of resolving: decide, fill in missing orders, flip to Rendering.
    /// What seat `seat_idx` plays in round `n` (the open one): its draft, or its last part when it has no draft or the
    /// draft goes over the sound budget (a draft played because the timer ran out, never committed), or nothing.
    pub fn orders_to_play(&self, seat_idx: usize, n: u32) -> Orders {
        let id = self.seats[seat_idx].id;
        let budget = self.config.sound_budget() as usize;
        let round = self.rounds.iter().find(|r| r.index == n);
        round
            .and_then(|r| r.orders.get(&id))
            .filter(|d| self.config.freeform || self.sounds_used(seat_idx, n, Some(d)) <= budget)
            .or_else(|| self.last_orders(id, n))
            .cloned()
            .unwrap_or_default()
    }

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
        let eligible: Vec<Seat> = self.seats.iter().filter(|s| s.plays_in(n)).cloned().collect();
        let mut filled: Vec<(SeatId, Orders)> = Vec::new();
        for s in &eligible {
            filled.push((s.id, self.orders_to_play(s.index as usize, n))); // a seat's join-order index is its place in `seats`
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

    /// Phase two of resolving, once round `n`'s mix is rendered: put it to a vote, or keep it.
    pub fn finish_resolve(&mut self, n: u32, wav: Arc<[u8]>, shared: &Shared) {
        let Some(round) = self.rounds.last_mut() else { return };
        if round.index != n {
            return;
        }
        round.mix = Some(wav);
        round.state = RoundState::Resolved;
        // Every attempt but the last is put to a vote; the last one is kept as it is.
        let vote = round.attempt < self.config.attempts_at(round.slot);
        if vote {
            round.votes = Some(HashMap::new());
        }
        self.emit("round_resolved", json!({"n": n}));
        if vote && self.vote_count().is_some_and(|(_, total)| total > 0) {
            self.count_votes(shared); // tells everyone the vote is on (0 of n)
        } else {
            if let Some(r) = self.rounds.last_mut() {
                r.votes = None;
            }
            self.keep_round(n, shared);
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

/// One seat's orders alone as a song file: played once from silence, with the tail ringing out (see `render::render_song`).
pub fn render_part_song(cfg: &RenderConfig, seat_index: u32, orders: &Orders) -> Vec<u8> {
    wav::encode(&render::render_song(cfg, &[vec![SeatPart { seat_index, orders }]]))
}

/// The parts played in each resolved round so far, in order: the loops of the song.
pub fn played_rounds(s: &Session) -> Vec<Vec<(u32, Orders)>> {
    s.rounds.iter().filter(|r| r.in_song()).map(|r| r.played.clone()).collect()
}

/// Rounds (each a list of seat index and orders) back to back as a song file, with the tail ringing out.
pub fn render_rounds_song(cfg: &RenderConfig, rounds: &[Vec<(u32, Orders)>]) -> Vec<u8> {
    let loops: Vec<Vec<SeatPart>> =
        rounds.iter().map(|r| r.iter().map(|(i, o)| SeatPart { seat_index: *i, orders: o }).collect()).collect();
    wav::encode(&render::render_song(cfg, &loops))
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

/// Every `SWEEP_EVERY`, remove the sessions that have `expired`. Runs for the life of the server.
pub fn spawn_sweeper(shared: Shared) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP_EVERY);
        loop {
            tick.tick().await;
            let now = now_ms();
            shared.write().await.sessions.retain(|_, s| !s.expired(now));
        }
    });
}

async fn render_song(shared: Shared, sid: String) {
    let job = {
        let g = shared.read().await;
        let Some(s) = g.sessions.get(&sid) else { return };
        (s.config.render_config(), played_rounds(s))
    };
    if job.1.is_empty() {
        return;
    }
    let wav = tokio::task::spawn_blocking(move || Arc::<[u8]>::from(render_rounds_song(&job.0, &job.1))).await;
    if let Ok(w) = wav {
        let mut g = shared.write().await;
        if let Some(s) = g.sessions.get_mut(&sid) {
            s.song = Some(w);
            s.emit("song_ready", json!({}));
        }
    }
}

/// What makes two instruments the same sound: everything but the id, the display name and the piano-roll hint.
pub fn sound_key(inst: &Instrument) -> String {
    let mut i = inst.clone();
    i.id.clear();
    i.name = None;
    i.piano_roll = false;
    serde_json::to_string(&i).unwrap_or_default()
}

/// The sounds a part plays: one per track with at least one note, keyed by `sound_key` and by how many tracks before
/// it in the part have the same sound (two tracks with one sound need two tracks in the combined scene). Must stay
/// identical to `partSounds` in client/js/combine.js.
pub fn part_sounds(o: &Orders) -> Vec<(String, usize)> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for lane in &o.lanes {
        if !lane.steps.iter().any(|s| s.note.is_some()) {
            continue;
        }
        let Some(inst) = o.instruments.iter().find(|i| i.id == lane.instrument) else { continue };
        let key = sound_key(inst);
        let k = seen.entry(key.clone()).or_insert(0);
        out.push((key, *k));
        *k += 1;
    }
    out
}
