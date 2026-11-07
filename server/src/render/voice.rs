//! Per-note voice instantiation. Mirrors the `voice` section of client/js/render.js.

use super::master::Master;
use super::{gain, RenderConfig, SeatPart, SAMPLE_RATE, SEAT_GAIN};
use crate::orders::{Edge, FilterMode, Instrument, Lane, NodeKind, NoiseColor, Wave};
use crate::prng::Mulberry32;
use std::collections::HashMap;
use web_audio_api::context::{BaseAudioContext, OfflineAudioContext};
use web_audio_api::node::{
    AudioNode, AudioScheduledSourceNode, AudioBufferSourceNode, BiquadFilterNode, BiquadFilterType,
    ConstantSourceNode, GainNode, OscillatorNode, OscillatorType, WaveShaperNode,
};
use web_audio_api::{AudioBuffer, AudioParam};

pub const NOISE_SECS: f64 = 1.0;
pub const MIDDLE_C_HZ: f64 = 261.6255653005986;
pub const SHAPER_CURVE_LEN: usize = 2048;
/// Env decay/release use setTargetAtTime with tau = time / ENV_TAU_DIV.
pub const ENV_TAU_DIV: f64 = 5.0;
pub const MIN_TIME: f64 = 0.001;
pub const STOP_PAD: f64 = 0.005;

enum VNode {
    Osc(OscillatorNode),
    Noise(AudioBufferSourceNode),
    Gain(GainNode),
    Filter(BiquadFilterNode),
    Env(ConstantSourceNode),
    Shaper(WaveShaperNode),
    Out(GainNode),
}

impl VNode {
    fn node(&self) -> &dyn AudioNode {
        match self {
            VNode::Osc(n) => n,
            VNode::Noise(n) => n,
            VNode::Gain(n) | VNode::Out(n) => n,
            VNode::Filter(n) => n,
            VNode::Env(n) => n,
            VNode::Shaper(n) => n,
        }
    }

    fn param(&self, port: &str) -> Option<&AudioParam> {
        match (self, port) {
            (VNode::Osc(n), "freq") => Some(n.frequency()),
            (VNode::Osc(n), "detune") => Some(n.detune()),
            (VNode::Gain(n), "gain") => Some(n.gain()),
            (VNode::Filter(n), "freq") => Some(n.frequency()),
            (VNode::Filter(n), "q") => Some(n.q()),
            (VNode::Filter(n), "detune") => Some(n.detune()),
            _ => None,
        }
    }
}

pub fn midi_hz(note: u8) -> f64 {
    440.0 * 2f64.powf((note as f64 - 69.0) / 12.0)
}

/// Generate the looped noise buffer for one noise node.
fn noise_buffer(cfg: &RenderConfig, seat_index: u32, inst: &str, node: &str, color: NoiseColor) -> AudioBuffer {
    let mut rng = Mulberry32::from_key(&format!("{}:{}:{}:{}", cfg.seed, seat_index, inst, node));
    let n = (NOISE_SECS * SAMPLE_RATE as f64) as usize;
    let mut d = vec![0f32; n];
    match color {
        NoiseColor::White => {
            for s in d.iter_mut() {
                *s = rng.next_bipolar() as f32;
            }
        }
        NoiseColor::Pink => {
            let (mut b0, mut b1, mut b2) = (0f64, 0f64, 0f64);
            for s in d.iter_mut() {
                let w = rng.next_bipolar();
                b0 = 0.99765 * b0 + w * 0.0990460;
                b1 = 0.96300 * b1 + w * 0.2965164;
                b2 = 0.57000 * b2 + w * 1.0526913;
                *s = ((b0 + b1 + b2 + w * 0.1848) * 0.25) as f32;
            }
        }
    }
    AudioBuffer::from(vec![d], SAMPLE_RATE)
}

fn shaper_curve(drive: f32) -> Vec<f32> {
    let drive = drive as f64;
    let norm = drive.tanh();
    (0..SHAPER_CURVE_LEN)
        .map(|i| {
            let x = 2.0 * i as f64 / (SHAPER_CURVE_LEN - 1) as f64 - 1.0;
            ((drive * x).tanh() / norm) as f32
        })
        .collect()
}

pub fn schedule_part(
    ctx: &OfflineAudioContext,
    master: &Master,
    cfg: &RenderConfig,
    part: &SeatPart,
    _loop_idx: usize,
    loop_start: f64,
) {
    // One bus per instrument: bus gain -> dry, plus send taps.
    struct Bus {
        input: GainNode,
        _taps: Vec<GainNode>,
    }
    let mut buses: HashMap<&str, Bus> = HashMap::new();
    let mut noise: HashMap<(&str, &str), AudioBuffer> = HashMap::new();
    for inst in &part.orders.instruments {
        let input = gain(ctx, inst.gain * SEAT_GAIN);
        input.connect(&master.dry);
        let sd = gain(ctx, inst.send_delay);
        let sr = gain(ctx, inst.send_reverb);
        input.connect(&sd);
        input.connect(&sr);
        sd.connect(&master.delay_in);
        sr.connect(&master.reverb_in);
        buses.insert(inst.id.as_str(), Bus { input, _taps: vec![sd, sr] });
        for n in &inst.nodes {
            if let NodeKind::Noise { color } = &n.kind {
                noise.insert(
                    (inst.id.as_str(), n.id.as_str()),
                    noise_buffer(cfg, part.seat_index, &inst.id, &n.id, *color),
                );
            }
        }
    }

    let insts: HashMap<&str, &Instrument> = part.orders.instruments.iter().map(|i| (i.id.as_str(), i)).collect();
    let row_secs = cfg.row_secs();
    let total_rows = cfg.total_rows();

    for lane in &part.orders.lanes {
        let (Some(inst), Some(bus)) = (insts.get(lane.instrument.as_str()), buses.get(lane.instrument.as_str())) else {
            continue;
        };
        for (note, vel, row, end_row) in lane_notes(lane, total_rows) {
            let t0 = loop_start + row as f64 * row_secs;
            let tg = loop_start + end_row as f64 * row_secs;
            build_voice(ctx, cfg, part.seat_index, inst, &bus.input, &noise, note, vel, t0, tg);
        }
    }
}

/// (note, vel, start_row, end_row) for each note-on, in row order.
pub fn lane_notes(lane: &Lane, total_rows: u32) -> Vec<(u8, u8, u32, u32)> {
    let mut steps: Vec<_> = lane.steps.iter().filter(|s| s.row < total_rows).collect();
    steps.sort_by_key(|s| s.row);
    let mut out = Vec::new();
    for (i, s) in steps.iter().enumerate() {
        if let Some(note) = s.note {
            let end = steps.get(i + 1).map(|n| n.row).unwrap_or(total_rows);
            if end > s.row {
                out.push((note, s.vel, s.row, end));
            }
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn build_voice(
    ctx: &OfflineAudioContext,
    _cfg: &RenderConfig,
    _seat_index: u32,
    inst: &Instrument,
    bus: &GainNode,
    noise: &HashMap<(&str, &str), AudioBuffer>,
    note: u8,
    vel: u8,
    t0: f64,
    tg: f64,
) {
    let hz = midi_hz(note);
    let max_release = inst
        .nodes
        .iter()
        .filter_map(|n| match &n.kind {
            NodeKind::Env { release, .. } => Some((*release as f64).max(0.0)),
            _ => None,
        })
        .fold(0.0, f64::max);
    let t_stop = tg + max_release + STOP_PAD;

    let mut nodes: HashMap<&str, VNode> = HashMap::new();
    for n in &inst.nodes {
        let v = match &n.kind {
            NodeKind::Osc { wave, semitones, detune, fixed_hz } => {
                let mut o = ctx.create_oscillator();
                o.set_type(match wave {
                    Wave::Sine => OscillatorType::Sine,
                    Wave::Square => OscillatorType::Square,
                    Wave::Sawtooth => OscillatorType::Sawtooth,
                    Wave::Triangle => OscillatorType::Triangle,
                });
                let f = match fixed_hz {
                    Some(h) => *h as f64,
                    None => hz * 2f64.powf(*semitones as f64 / 12.0),
                };
                o.frequency().set_value(f as f32);
                o.detune().set_value(*detune);
                o.start_at(t0);
                o.stop_at(t_stop);
                VNode::Osc(o)
            }
            NodeKind::Noise { .. } => {
                let mut s = ctx.create_buffer_source();
                if let Some(buf) = noise.get(&(inst.id.as_str(), n.id.as_str())) {
                    s.set_buffer(buf.clone());
                }
                s.set_loop(true);
                s.start_at(t0);
                s.stop_at(t_stop);
                VNode::Noise(s)
            }
            NodeKind::Gain { gain: g } => VNode::Gain(gain(ctx, *g)),
            NodeKind::Filter { mode, freq, q, key_track } => {
                let mut f = ctx.create_biquad_filter();
                f.set_type(match mode {
                    FilterMode::Lowpass => BiquadFilterType::Lowpass,
                    FilterMode::Highpass => BiquadFilterType::Highpass,
                    FilterMode::Bandpass => BiquadFilterType::Bandpass,
                    FilterMode::Notch => BiquadFilterType::Notch,
                });
                let cutoff = (*freq as f64) * (hz / MIDDLE_C_HZ).powf(*key_track as f64);
                f.frequency().set_value(cutoff.clamp(10.0, 22000.0) as f32);
                f.q().set_value(*q);
                VNode::Filter(f)
            }
            NodeKind::Env { attack, decay, sustain, release, amount } => {
                let mut c = ctx.create_constant_source();
                schedule_env(c.offset(), *attack as f64, *decay as f64, *sustain as f64, *release as f64, *amount, t0, tg);
                c.start_at(t0);
                c.stop_at(t_stop);
                VNode::Env(c)
            }
            NodeKind::Shaper { drive } => {
                let mut w = ctx.create_wave_shaper();
                w.set_curve(shaper_curve(*drive));
                VNode::Shaper(w)
            }
            NodeKind::Out {} => VNode::Out(gain(ctx, vel as f32 / 127.0)),
        };
        nodes.insert(n.id.as_str(), v);
    }

    for Edge { from, to, port } in &inst.edges {
        let (Some(a), Some(b)) = (nodes.get(from.as_str()), nodes.get(to.as_str())) else { continue };
        match port {
            None => {
                a.node().connect(b.node());
            }
            Some(p) => {
                if let Some(param) = b.param(p) {
                    a.node().connect(param);
                }
            }
        }
    }
    // Voice output -> instrument bus.
    for v in nodes.values() {
        if let VNode::Out(g) = v {
            g.connect(bus);
        }
    }
    // Nodes may be dropped here: the render graph keeps scheduled sources alive until they stop.
}

/// ADSR on an AudioParam. Attack is linear, decay and release are exponential approaches.
/// Must stay identical to `scheduleEnv` in client/js/render.js.
#[allow(clippy::too_many_arguments)]
pub fn schedule_env(p: &AudioParam, a: f64, d: f64, s: f64, r: f64, amount: f32, t0: f64, tg: f64) {
    let a = a.max(MIN_TIME);
    let d = d.max(MIN_TIME);
    let r = r.max(MIN_TIME);
    let amt = amount as f64;
    p.set_value_at_time(0.0, t0);
    let gate = tg - t0;
    if gate <= a {
        // Released during attack: ramp to the reached level, then release from there.
        p.linear_ramp_to_value_at_time((amt * gate / a) as f32, tg);
    } else {
        p.linear_ramp_to_value_at_time(amount, t0 + a);
        let sustain = amt * s;
        let tau_d = d / ENV_TAU_DIV;
        p.set_target_at_time(sustain as f32, t0 + a, tau_d);
        // Level of the decay curve at gate end (the spec's setTarget formula).
        let level = sustain + (amt - sustain) * (-(tg - (t0 + a)) / tau_d).exp();
        // web-audio-api 1.7.0 bug: a setTarget that is still in the future overwrites the held
        // value with exp(+(t - T0) / tau) at the end of every block, which explodes whenever the
        // value being held differs from the target (any sustain > 0). An explicit setValueAtTime
        // at the same instant keeps the setTarget behind it in the queue until it really starts.
        // The value equals the curve's own, so browsers render the same. Mirror this in the JS port.
        p.set_value_at_time(level as f32, tg);
    }
    p.set_target_at_time(0.0, tg, r / ENV_TAU_DIV);
}
