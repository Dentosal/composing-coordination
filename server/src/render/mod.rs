//! Canonical offline renderer: orders -> Web Audio graph -> stereo samples -> WAV.
//!
//! Keep structurally parallel to client/js/render.js.

mod master;
pub mod voice;
pub mod wav;
pub use voice::{fx_plan, param_target, FxSegment, ParamEvent, ParamTarget, ParamTrack};

use crate::orders::Orders;
use web_audio_api::context::{BaseAudioContext, OfflineAudioContext};
use web_audio_api::node::GainNode;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// Seconds of song between the points where rendering pauses to build the next voices.
const CHUNK_SECS: f64 = 2.0;
/// Frames per render quantum, the unit the context renders (and suspends) in.
const RENDER_QUANTUM: usize = 128;

pub const SAMPLE_RATE: f32 = 48000.0;
/// Per-seat headroom applied on every instrument bus.
pub const SEAT_GAIN: f32 = 0.25;

#[derive(Clone, Debug)]
pub struct RenderConfig {
    pub bpm: f32,
    pub bars: u32,
    pub rows_per_bar: u32,
    pub seed: u64,
}

impl RenderConfig {
    pub fn total_rows(&self) -> u32 {
        self.bars * self.rows_per_bar
    }
    /// Rows are subdivisions of a 4/4 bar.
    pub fn row_secs(&self) -> f64 {
        let rows_per_beat = self.rows_per_bar as f64 / 4.0;
        60.0 / (self.bpm as f64 * rows_per_beat)
    }
    pub fn loop_secs(&self) -> f64 {
        self.row_secs() * self.total_rows() as f64
    }
    pub fn loop_frames(&self) -> usize {
        (self.loop_secs() * SAMPLE_RATE as f64).round() as usize
    }
}

#[derive(Clone, Copy)]
pub struct SeatPart<'a> {
    /// Join-order index of the seat; part of the PRNG key.
    pub seat_index: u32,
    pub orders: &'a Orders,
}

/// Stereo float samples, one Vec per channel.
pub struct Stereo {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

/// Render consecutive loops in one pass. `loops[i]` holds the parts playing during loop i.
/// Output covers loops `keep_from..loops.len()`.
///
/// - A single round's mix is `render(cfg, &[parts, parts], 1)`: the first copy exists only so
///   reverb/delay tails and release stages wrap into the loop start.
/// - The full song is `render(cfg, &per_round_parts, 0)`.
pub fn render(cfg: &RenderConfig, loops: &[Vec<SeatPart>], keep_from: usize) -> Stereo {
    render_with_tail(cfg, loops, keep_from, 0)
}

/// Seconds rendered past the end of a song file, for release stages and reverb/delay tails. Must stay identical to
/// `SONG_TAIL_SECS` in client/js/offline.js.
pub const SONG_TAIL_SECS: f64 = 4.0;
/// Tail samples quieter than this are silence (they round to 0 in 16-bit PCM).
const SILENCE: f32 = 0.5 / 32767.0;

/// A song file: the loops played once from silence, then a tail of up to `SONG_TAIL_SECS` in which notes and
/// effects ring out, with its trailing silence trimmed.
pub fn render_song(cfg: &RenderConfig, loops: &[Vec<SeatPart>]) -> Stereo {
    let tail = (SONG_TAIL_SECS * SAMPLE_RATE as f64).round() as usize;
    let mut s = render_with_tail(cfg, loops, 0, tail);
    let body = s.left.len() - tail;
    let end = (body..s.left.len()).rev().find(|&i| s.left[i].abs() > SILENCE || s.right[i].abs() > SILENCE).map_or(body, |i| i + 1);
    s.left.truncate(end);
    s.right.truncate(end);
    s
}

fn render_with_tail(cfg: &RenderConfig, loops: &[Vec<SeatPart>], keep_from: usize, tail_frames: usize) -> Stereo {
    let frames_per_loop = cfg.loop_frames();
    let total_frames = frames_per_loop * loops.len() + tail_frames;
    let mut ctx = OfflineAudioContext::new(2, total_frames, SAMPLE_RATE);

    let master = master::Master::new(&ctx, cfg);

    let mut jobs = Vec::new();
    for (loop_idx, parts) in loops.iter().enumerate() {
        let loop_start = loop_idx as f64 * cfg.loop_secs();
        for part in parts.iter() {
            voice::plan_part(&ctx, &master, cfg, part, loop_start, &mut jobs);
        }
    }
    // Voices are built in chunks while rendering, each shortly before it starts: every node in the graph costs time on
    // every render quantum, so building them all up front made a render's time grow with the square of its length.
    // The rendering suspends every CHUNK_SECS (a whole number of render quanta, where suspending is exact) to build the
    // voices that start before the next suspension; none of them starts in the past.
    jobs.sort_by(|a, b| a.start.total_cmp(&b.start));
    let jobs = Arc::new(Mutex::new(VecDeque::from(jobs)));
    let build_until = |ctx: &OfflineAudioContext, cfg: &RenderConfig, jobs: &Mutex<VecDeque<voice::VoiceJob>>, until: f64| {
        let mut q = jobs.lock().unwrap();
        while q.front().is_some_and(|j| j.start < until) {
            q.pop_front().unwrap().build(ctx, cfg);
        }
    };
    let chunk = (CHUNK_SECS * SAMPLE_RATE as f64) as usize / RENDER_QUANTUM * RENDER_QUANTUM;
    let stops: Vec<f64> = (chunk..total_frames).step_by(chunk).map(|f| f as f64 / SAMPLE_RATE as f64).collect();
    build_until(&ctx, cfg, &jobs, stops.first().copied().unwrap_or(f64::INFINITY));
    for (i, &at) in stops.iter().enumerate() {
        let next = stops.get(i + 1).copied().unwrap_or(f64::INFINITY);
        let (jobs, cfg) = (jobs.clone(), cfg.clone());
        ctx.suspend_sync(at, move |ctx| build_until(ctx, &cfg, &jobs, next));
    }
    drop(jobs);

    // Keep the master chain's sources alive until rendering finishes.
    let buf = ctx.start_rendering_sync();
    drop(master);

    let from = frames_per_loop * keep_from;
    let left = buf.get_channel_data(0)[from..].to_vec();
    let right = buf.get_channel_data(1)[from..].to_vec();
    Stereo { left, right }
}

/// Helper used by both master and voice code: a constant-gain node.
pub(crate) fn gain(ctx: &OfflineAudioContext, value: f32) -> GainNode {
    let g = ctx.create_gain();
    g.gain().set_value(value);
    g
}
