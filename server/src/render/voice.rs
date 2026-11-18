//! Per-note voice instantiation. Mirrors the `voice` section of client/js/render.js.

use super::master::Master;
use super::{gain, RenderConfig, SeatPart, SAMPLE_RATE, SEAT_GAIN};
use crate::orders::{unison_offsets, ShaperShape, Edge, FilterMode, FxStep, Instrument, Lane, NodeKind, NoiseColor, Wave, ARP_TICKS_PER_ROW};
use crate::prng::Mulberry32;
use std::collections::HashMap;
use web_audio_api::context::{BaseAudioContext, OfflineAudioContext};
use web_audio_api::node::{
    AudioNode, AudioScheduledSourceNode, AudioBufferSourceNode, BiquadFilterNode, BiquadFilterType,
    ConstantSourceNode, GainNode, OscillatorNode, OscillatorType, WaveShaperNode,
};
use web_audio_api::{AudioBuffer, AudioParam, PeriodicWave, PeriodicWaveOptions};
use std::cell::RefCell;

pub const NOISE_SECS: f64 = 1.0;
pub const MIDDLE_C_HZ: f64 = 261.6255653005986;
pub const SHAPER_CURVE_LEN: usize = 2048;
/// Env decay/release use setTargetAtTime with tau = time / ENV_TAU_DIV.
pub const ENV_TAU_DIV: f64 = 5.0;
pub const MIN_TIME: f64 = 0.001;
pub const STOP_PAD: f64 = 0.005;

enum VNode {
    /// One oscillator, or the copies of a unison oscillator with the gain that mixes them.
    Osc(Vec<OscillatorNode>, Option<GainNode>),
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
            VNode::Osc(v, mix) => match mix {
                Some(g) => g,
                None => &v[0],
            },
            VNode::Noise(n) => n,
            VNode::Gain(n) | VNode::Out(n) => n,
            VNode::Filter(n) => n,
            VNode::Env(n) => n,
            VNode::Shaper(n) => n,
        }
    }

    fn params(&self, port: &str) -> Vec<&AudioParam> {
        match (self, port) {
            (VNode::Osc(v, _), "freq") => v.iter().map(|o| o.frequency()).collect(),
            (VNode::Osc(v, _), "detune") => v.iter().map(|o| o.detune()).collect(),
            (VNode::Gain(n), "gain") => vec![n.gain()],
            (VNode::Filter(n), "freq") => vec![n.frequency()],
            (VNode::Filter(n), "q") => vec![n.q()],
            (VNode::Filter(n), "detune") => vec![n.detune()],
            _ => vec![],
        }
    }
}

/// Fourier coefficients (real, imag; index 0 unused) of a built-in wave shape shifted by `phase` cycles, with
/// `harmonics` harmonics (the spec's formulas for the built-in types). Unison copies use these so that they start
/// at different points of the cycle instead of all at phase 0 (which makes the start of a note `n` times as loud).
/// Must stay identical to `unisonCoeffs` in client/js/voice.js (checked against server/tests/fixtures/unison_wave.json).
pub fn wave_coeffs(wave: Wave, harmonics: usize, phase: f64) -> (Vec<f32>, Vec<f32>) {
    use std::f64::consts::PI;
    let mut real = vec![0f32; harmonics + 1];
    let mut imag = vec![0f32; harmonics + 1];
    for n in 1..=harmonics {
        let k = n as f64;
        let b = match wave {
            Wave::Sine => (n == 1) as u8 as f64,
            Wave::Square => if n % 2 == 1 { 4.0 / (k * PI) } else { 0.0 },
            Wave::Sawtooth => 2.0 / (k * PI) * if n % 2 == 1 { 1.0 } else { -1.0 },
            Wave::Triangle => 8.0 * (k * PI / 2.0).sin() / (k * PI).powi(2),
        };
        let a = 2.0 * PI * phase * k;
        real[n] = (b * a.sin()) as f32;
        imag[n] = (b * a.cos()) as f32;
    }
    (real, imag)
}

/// How many harmonics a unison copy's wave table gets: all that stay under the Nyquist frequency at the highest
/// pitch the voice reaches (`max_hz`), rounded down to a power of two so the tables can be cached.
/// Must stay identical to `unisonHarmonics` in client/js/voice.js.
pub fn unison_harmonics(max_hz: f64) -> usize {
    let fit = (SAMPLE_RATE as f64 / 2.0 / max_hz).floor().max(1.0) as usize;
    let mut h = 1;
    while h * 2 <= fit && h < 512 {
        h *= 2;
    }
    h
}

/// Start phase (in cycles) of copy `i` of `n` unison copies. Evenly spaced phases would make the copies cancel every
/// harmonic that is not a multiple of `n` (a hollow, quiet start), and equal phases make the start `n` times as loud.
/// These were searched offline so the copies add up like uncorrelated signals (power about `n`) on the low harmonics.
/// Must stay identical to `unisonPhase` in client/js/voice.js (checked against server/tests/fixtures/unison_wave.json).
pub fn unison_phase(i: usize, n: usize) -> f64 {
    const PHASES: [&[f64]; 8] = [
        &[],
        &[0.0],
        &[0.0, 0.75],
        &[0.0, 0.722, 0.112],
        &[0.0, 0.854, 0.562, 0.625],
        &[0.0, 0.539, 0.621, 0.96, 0.729],
        &[0.0, 0.78, 0.854, 0.416, 0.805, 0.531],
        &[0.0, 0.769, 0.086, 0.244, 0.281, 0.704, 0.105],
    ];
    PHASES[n.min(7)].get(i).copied().unwrap_or(0.0)
}

thread_local! {
    static WAVES: RefCell<HashMap<(u8, usize, u8, u8), PeriodicWave>> = RefCell::new(HashMap::new());
}

/// The cached wave for copy `i` of `n` (its start phase is `unison_phase`).
fn unison_wave(ctx: &OfflineAudioContext, wave: Wave, harmonics: usize, i: usize, n: usize) -> PeriodicWave {
    let key = (wave as u8, harmonics, i as u8, n as u8);
    WAVES.with(|w| {
        w.borrow_mut()
            .entry(key)
            .or_insert_with(|| {
                let (real, imag) = wave_coeffs(wave, harmonics, unison_phase(i, n));
                ctx.create_periodic_wave(PeriodicWaveOptions { real: Some(real), imag: Some(imag), disable_normalization: false })
            })
            .clone()
    })
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

/// One point of a waveshaper curve: `x` in -1..=1 in, the shaped value out. `drive` is the gain into the curve, `param`
/// the shape's second setting. Everything is f64 and the rounding is explicit (floor), so the browser gets the same table.
/// Must stay identical to `shapeValue` in client/js/voice.js (checked against server/tests/fixtures/shaper.json).
pub fn shape_value(shape: ShaperShape, drive: f64, param: f64, x: f64) -> f64 {
    let u = drive * x;
    match shape {
        // tanh, scaled so that x = 1 comes out as 1 whatever the drive
        ShaperShape::Soft => u.tanh() / drive.tanh(),
        // flat clip at +-1 (scaled the same way for drives below 1, where nothing clips)
        ShaperShape::Hard => u.clamp(-1.0, 1.0) / drive.min(1.0),
        // reflect at the rails: a triangle fold, identity for |u| <= 1
        ShaperShape::Fold => {
            let t = (u + 1.0).rem_euclid(4.0);
            if t < 2.0 { t - 1.0 } else { 3.0 - t }
        }
        // tanh around a bias (the param, 0..1): the two halves clip differently, which adds even harmonics.
        // The bias is taken out at x = 0 so silence stays silent; scaled so the larger half peaks at 1.
        ShaperShape::Asym => {
            let b = param;
            let norm = ((drive + b).tanh() - b.tanh()).max(b.tanh() - (b - drive).tanh());
            ((u + b).tanh() - b.tanh()) / norm
        }
        // round to a grid of 2^(bits-1) steps per unit (a mid-tread quantiser: zero stays zero)
        ShaperShape::Crush => {
            let k = 2f64.powf(param - 1.0);
            ((u.clamp(-1.0, 1.0) * k + 0.5).floor() / k).clamp(-1.0, 1.0)
        }
    }
}

pub fn shaper_curve(shape: ShaperShape, drive: f32, param: Option<f32>) -> Vec<f32> {
    let param = param.unwrap_or(shape.default_param()) as f64;
    (0..SHAPER_CURVE_LEN)
        .map(|i| {
            let x = 2.0 * i as f64 / (SHAPER_CURVE_LEN - 1) as f64 - 1.0;
            shape_value(shape, drive as f64, param, x) as f32
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
            for seg in fx_plan(&lane.fx, row, end_row, row_secs) {
                build_voice(ctx, cfg, part.seat_index, inst, &bus.input, &noise, note, vel, t0 + seg.start, t0 + seg.end, &seg);
            }
        }
    }
}

/// One voice of a note: a note is split into several voices by retriggers, and ended early by a cut.
/// Times are seconds after the note's start; the automation times are seconds after the voice's own start.
#[derive(Debug, Default, PartialEq)]
pub struct FxSegment {
    pub start: f64,
    pub end: f64,
    /// (time, volume multiplier) whenever the volume changes; the voice starts at 1. A voice that ends early (cut or
    /// retrigger) gets a final 0 at its end, so it is silent from that instant.
    pub volumes: Vec<(f64, f32)>,
    /// (time, semitone offset) of the oscillators (slide + arpeggio), whenever it changes; the voice starts at 0.
    pub pitches: Vec<(f64, f64)>,
}

/// The voices of one note, from its lane's effect cells. Everything is quantised to ticks (`ARP_TICKS_PER_ROW` per row):
///   volume   multiplies the level during its row (rows without one are at 1)
///   arp      the pitch steps through the offsets, one per tick, restarting at the start of the row
///   slide    the pitch moves by N semitones over the row (reaching it at the row's last tick) and stays there
///   cut      the note ends (and is silenced) at that tick of the row
///   retrig   the note restarts every N ticks within the row (a new voice; the old one is silenced)
/// Must stay identical to `notePlan` in client/js/fx.js (both are checked against server/tests/fixtures/fx_plan.json).
pub fn fx_plan(fx: &[FxStep], start_row: u32, end_row: u32, row_secs: f64) -> Vec<FxSegment> {
    let tpr = ARP_TICKS_PER_ROW as usize;
    let tick = row_secs / tpr as f64;
    let n_ticks = (end_row - start_row) as usize * tpr;
    let natural_end = (end_row - start_row) as f64 * row_secs;
    if fx.is_empty() {
        return vec![FxSegment { start: 0.0, end: natural_end, ..Default::default() }];
    }
    let by_row: HashMap<u32, &FxStep> = fx.iter().map(|f| (f.row, f)).collect();
    let mut vol: Vec<f32> = Vec::with_capacity(n_ticks);
    let mut pitch: Vec<f64> = Vec::with_capacity(n_ticks);
    let mut accum = 0.0f64;
    let mut cut: Option<usize> = None;
    let mut retrig: Vec<usize> = Vec::new();
    for r in start_row..end_row {
        let f = by_row.get(&r);
        let slide = f.and_then(|f| f.slide).unwrap_or(0) as f64;
        let arp = f.and_then(|f| f.arp.as_ref()).filter(|a| !a.offsets.is_empty());
        for k in 0..tpr {
            vol.push(f.and_then(|f| f.volume).unwrap_or(1.0));
            let off = arp.map_or(0.0, |a| a.offsets[k % a.offsets.len()] as f64);
            pitch.push(accum + (slide * (k + 1) as f64) / tpr as f64 + off);
        }
        accum += slide;
        let base = (r - start_row) as usize * tpr;
        if cut.is_none() {
            if let Some(c) = f.and_then(|f| f.cut) {
                cut = Some(base + c as usize);
            }
        }
        if let Some(n) = f.and_then(|f| f.retrig) {
            let mut k = n as usize;
            while k < tpr {
                retrig.push(base + k);
                k += n as usize;
            }
        }
    }
    let end = cut.map_or(n_ticks, |c| c.min(n_ticks));
    retrig.sort_unstable();
    let mut bounds = vec![0usize];
    bounds.extend(retrig.into_iter().filter(|&t| t > 0 && t < end));
    let mut segs = Vec::new();
    for (j, &s) in bounds.iter().enumerate() {
        let e = bounds.get(j + 1).copied().unwrap_or(end);
        if e <= s {
            continue;
        }
        let (mut vl, mut pl) = (1.0f32, 0.0f64);
        let (mut vs, mut ps) = (Vec::new(), Vec::new());
        for i in s..e {
            let t = (i - s) as f64 * tick;
            if vol[i] != vl {
                vs.push((t, vol[i]));
                vl = vol[i];
            }
            if pitch[i] != pl {
                ps.push((t, pitch[i]));
                pl = pitch[i];
            }
        }
        let natural = e == n_ticks;
        if !natural {
            vs.push(((e - s) as f64 * tick, 0.0));
        }
        segs.push(FxSegment { start: s as f64 * tick, end: if natural { natural_end } else { e as f64 * tick }, volumes: vs, pitches: ps });
    }
    segs
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
    plan: &FxSegment,
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
            NodeKind::Osc { wave, semitones, detune, fixed_hz, unison, spread } => {
                let f = match fixed_hz {
                    Some(h) => *h as f64,
                    None => hz * 2f64.powf(*semitones as f64 / 12.0),
                };
                let offsets = unison_offsets(*unison, *spread);
                let mut voices = Vec::with_capacity(offsets.len());
                let top_semis = plan.pitches.iter().fold(0f64, |m, (_, s)| m.max(*s));
                let top_cents = *detune as f64 + offsets.iter().fold(0f32, |m, o| m.max(*o)) as f64 + top_semis * 100.0;
                let harmonics = unison_harmonics(f * 2f64.powf(top_cents.max(0.0) / 1200.0));
                for (i, off) in offsets.iter().enumerate() {
                    let mut o = ctx.create_oscillator();
                    if offsets.len() > 1 {
                        // Copies start at different points of the cycle (see `unison_phase`), so they do not all add up at the start of the note.
                        o.set_periodic_wave(unison_wave(ctx, *wave, harmonics, i, offsets.len()));
                    } else {
                        o.set_type(match wave {
                            Wave::Sine => OscillatorType::Sine,
                            Wave::Square => OscillatorType::Square,
                            Wave::Sawtooth => OscillatorType::Sawtooth,
                            Wave::Triangle => OscillatorType::Triangle,
                        });
                    }
                    o.frequency().set_value(f as f32);
                    o.detune().set_value(*detune + off);
                    if fixed_hz.is_none() {
                        // Arpeggio ticks: the detune param carries the semitone offset (in cents) on top of the oscillator's own detune.
                        for (t, semis) in &plan.pitches {
                            o.detune().set_value_at_time(*detune + off + (*semis * 100.0) as f32, t0 + t);
                        }
                    }
                    o.start_at(t0);
                    o.stop_at(t_stop);
                    voices.push(o);
                }
                let mix = (offsets.len() > 1).then(|| {
                    let g = gain(ctx, 1.0 / (offsets.len() as f32).sqrt());
                    for o in &voices {
                        o.connect(&g);
                    }
                    g
                });
                VNode::Osc(voices, mix)
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
            NodeKind::Gain { gain: g, key_track } => {
                VNode::Gain(gain(ctx, *g * (hz / MIDDLE_C_HZ).powf(*key_track as f64) as f32))
            }
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
            NodeKind::Shaper { drive, shape, param } => {
                let mut w = ctx.create_wave_shaper();
                w.set_curve(shaper_curve(*shape, *drive, *param));
                VNode::Shaper(w)
            }
            NodeKind::Out {} => {
                let level = vel as f32 / 127.0;
                let g = gain(ctx, level);
                for (t, v) in &plan.volumes {
                    g.gain().set_value_at_time(level * v, t0 + t);
                }
                VNode::Out(g)
            }
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
                for param in b.params(p) {
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
