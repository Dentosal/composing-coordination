//! Canonical offline renderer: orders -> Web Audio graph -> stereo samples -> WAV.
//!
//! Keep structurally parallel to client/js/render.js.

mod master;
mod voice;
pub mod wav;
pub use voice::{fx_plan, FxPlan};

use crate::orders::Orders;
use web_audio_api::context::{BaseAudioContext, OfflineAudioContext};
use web_audio_api::node::GainNode;

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
    let frames_per_loop = cfg.loop_frames();
    let total_frames = frames_per_loop * loops.len();
    let mut ctx = OfflineAudioContext::new(2, total_frames, SAMPLE_RATE);

    let master = master::Master::new(&ctx, cfg);

    for (loop_idx, parts) in loops.iter().enumerate() {
        let loop_start = loop_idx as f64 * cfg.loop_secs();
        for part in parts.iter() {
            voice::schedule_part(&ctx, &master, cfg, part, loop_idx, loop_start);
        }
    }

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
