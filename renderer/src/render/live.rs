//! Live playback: the parts rendered while they play, for as long as they play (the browser's streaming player runs this
//! in a worker, see renderer/wasm and client/js/stream.js). The rows play in the same order as the browser's live
//! sequencer did: from a start row to the end of the loop region, then the region over and over. Each row's voices are
//! built just before it plays, from the parts as they are then, so an edit is heard from the next row not yet built.
//! Notes are cut at the end of the loop region; reverb, delay and releases ring on into the next pass.

use super::master::Master;
use super::voice::{inst_bus, play_note, seat_noise, InstBus};
use super::{RenderConfig, SAMPLE_RATE};
use crate::orders::Orders;
use serde::Deserialize;
use std::collections::HashMap;
use web_audio_api::context::{BaseAudioContext, OfflineAudioContext};
use web_audio_api::AudioBuffer;

/// Where playback starts and what it loops: rows `loop_start..loop_end`, starting at `start` (inside the region).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transport {
    pub start: u32,
    pub loop_start: u32,
    pub loop_end: u32,
}

impl Transport {
    /// The pattern row played `k`-th (the first row played is k = 0).
    pub fn row(&self, k: u64) -> u32 {
        let first = (self.loop_end - self.start) as u64;
        if k < first {
            self.start + k as u32
        } else {
            self.loop_start + ((k - first) % (self.loop_end - self.loop_start) as u64) as u32
        }
    }

    fn clamped(self, total: u32) -> Transport {
        let loop_start = self.loop_start.min(total.saturating_sub(1));
        let loop_end = self.loop_end.clamp(loop_start + 1, total.max(loop_start + 1));
        let start = self.start.clamp(loop_start, loop_end - 1);
        Transport { start, loop_start, loop_end }
    }
}

/// One seat's part, as the player sends it.
#[derive(Deserialize)]
pub struct LivePart {
    pub seat: u32,
    pub orders: Orders,
}

/// A command for a running player (JSON): new parts (an edit, a mute), and/or stop.
#[derive(Deserialize, Default)]
pub struct Command {
    #[serde(default)]
    pub parts: Option<Vec<LivePart>>,
    #[serde(default)]
    pub stop: bool,
}

/// How far ahead of the render position a row's voices are built, in frames: a little, so they are in place in time,
/// and no more, so an edit is picked up as soon as possible.
const BUILD_AHEAD: u64 = 256;
/// How often (in render quanta) the player asks for commands.
const POLL_EVERY: u64 = 4;

/// Play the parts until a command says stop. `poll` returns the next command, if any (it is asked every few
/// milliseconds of audio); `sink` gets the audio, one render quantum of left and right at a time.
pub fn run(cfg: &RenderConfig, transport: Transport, parts: Vec<LivePart>, poll: &mut dyn FnMut() -> Option<Command>, sink: &mut dyn FnMut(&[f32], &[f32])) {
    let transport = transport.clamped(cfg.total_rows());
    let mut ctx = OfflineAudioContext::new(2, 128, SAMPLE_RATE);
    let master = Master::new(&ctx, cfg, &ctx.destination());
    let mut player = Player { cfg, transport, master: &master, parts, buses: HashMap::new(), noise: HashMap::new(), next_k: 0 };
    // The first rows' voices must be in place before the first quantum renders.
    player.build_until(&ctx, BUILD_AHEAD);
    let mut quantum: u64 = 0;
    ctx.render_stream_sync(|ctx, block| {
        let left = block[0];
        let right = block.get(1).copied().unwrap_or(left);
        sink(left, right);
        quantum += 1;
        if quantum % POLL_EVERY == 0 {
            while let Some(cmd) = poll() {
                if cmd.stop {
                    return false;
                }
                if let Some(p) = cmd.parts {
                    player.parts = p;
                }
            }
        }
        player.build_until(ctx, quantum * 128 + BUILD_AHEAD);
        true
    });
    drop(player);
    drop(master);
}

/// The scheduling state of a run.
struct Player<'a> {
    cfg: &'a RenderConfig,
    transport: Transport,
    master: &'a Master,
    parts: Vec<LivePart>,
    /// Instrument buses, built as needed and kept while the instrument's bus settings stay the same.
    buses: HashMap<(u32, String), (BusKey, InstBus)>,
    /// Noise buffers, kept for the whole run (they only depend on seat, instrument, node and colour).
    noise: HashMap<(u32, String, String, String), AudioBuffer>,
    /// The next row (in play order) whose voices are not built yet.
    next_k: u64,
}

impl Player<'_> {
    /// Build the voices of every row that starts before `frame`.
    fn build_until(&mut self, ctx: &OfflineAudioContext, frame: u64) {
        let cfg = self.cfg;
        let total = cfg.total_rows();
        let row_secs = cfg.row_secs();
        let horizon = frame as f64 / SAMPLE_RATE as f64;
        while (self.next_k as f64) * row_secs < horizon {
            let row = self.transport.row(self.next_k);
            let t_row = self.next_k as f64 * row_secs;
            for part in &self.parts {
                for lane in &part.orders.lanes {
                    // The note starting at this row, and where it ends: the lane's next step, or the end of the song,
                    // and the end of the loop region while playing inside it.
                    let mut on = None;
                    let mut next = total;
                    for s in &lane.steps {
                        if s.row >= total {
                            continue;
                        }
                        if s.row == row {
                            on = Some(s);
                        } else if s.row > row && s.row < next {
                            next = s.row;
                        }
                    }
                    let Some(step) = on else { continue };
                    let Some(note) = step.note else { continue };
                    let Some(inst) = part.orders.instruments.iter().find(|i| i.id == lane.instrument) else { continue };
                    let end_row = if row < self.transport.loop_end { next.min(self.transport.loop_end) } else { next };
                    let key = (part.seat, inst.id.clone());
                    let wanted = BusKey::of(inst);
                    if self.buses.get(&key).map(|(k, _)| *k != wanted).unwrap_or(true) {
                        let seat = part.seat;
                        let noise = &mut self.noise;
                        let ib = inst_bus(ctx, self.master, inst, &mut |node, color| {
                            noise
                                .entry((seat, inst.id.clone(), node.to_string(), format!("{color:?}")))
                                .or_insert_with(|| seat_noise(cfg, seat, &inst.id, node, color))
                                .clone()
                        });
                        self.buses.insert(key.clone(), (wanted, ib));
                    }
                    play_note(ctx, cfg, part.seat, &self.buses[&key].1, lane, note, step.vel, row, end_row, t_row);
                }
            }
            self.next_k += 1;
        }
    }
}

/// What an instrument's bus depends on: its gain and send levels. A change rebuilds the bus (notes already playing keep
/// the old one until they end).
#[derive(Clone, Copy, PartialEq)]
struct BusKey {
    gain: f32,
    send_delay: f32,
    send_reverb: f32,
}

impl BusKey {
    fn of(inst: &crate::orders::Instrument) -> BusKey {
        BusKey { gain: inst.gain, send_delay: inst.send_delay, send_reverb: inst.send_reverb }
    }
}
