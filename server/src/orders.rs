//! The orders format: the shared contract between client and server.
//!
//! A player's `Orders` hold instruments (small signal graphs, instantiated once per note)
//! and lanes (pattern columns that play one instrument each).
//!
//! JSON example:
//! ```json
//! { "instruments": [ { "id": "bass", "gain": 0.8, "send_delay": 0.0, "send_reverb": 0.1,
//!     "nodes": [ {"id":"o","type":"osc","wave":"sawtooth"},
//!                {"id":"f","type":"filter","mode":"lowpass","freq":800,"q":1,"key_track":0.5},
//!                {"id":"e","type":"env","attack":0.01,"decay":0.2,"sustain":0.6,"release":0.1,"amount":1},
//!                {"id":"g","type":"gain","gain":0},
//!                {"id":"out","type":"out"} ],
//!     "edges": [ {"from":"o","to":"f"}, {"from":"f","to":"g"},
//!                {"from":"e","to":"g","port":"gain"}, {"from":"g","to":"out"} ] } ],
//!   "lanes": [ { "instrument": "bass", "steps": [ {"row":0,"note":36,"vel":110}, {"row":8,"note":null} ] } ] }
//! ```

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Orders {
    #[serde(default)]
    pub instruments: Vec<Instrument>,
    #[serde(default)]
    pub lanes: Vec<Lane>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Instrument {
    pub id: String,
    /// Optional display name chosen by the player (the id stays the stable key lanes refer to).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Bus level, 0..=1.
    #[serde(default = "default_gain")]
    pub gain: f32,
    /// Send level to the shared delay, 0..=1.
    #[serde(default)]
    pub send_delay: f32,
    /// Send level to the shared reverb, 0..=1.
    #[serde(default)]
    pub send_reverb: f32,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

fn default_gain() -> f32 {
    0.8
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Node {
    pub id: String,
    #[serde(flatten)]
    pub kind: NodeKind,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Wave {
    Sine,
    Square,
    Sawtooth,
    Triangle,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterMode {
    Lowpass,
    Highpass,
    Bandpass,
    Notch,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoiseColor {
    White,
    Pink,
}

/// Node types. Each maps onto one Web Audio primitive.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NodeKind {
    /// OscillatorNode. Frequency = note pitch * 2^(semitones/12), unless `fixed_hz` is set
    /// (use that for LFOs and sub-audio use). Ports: `freq` (Hz), `detune` (cents).
    Osc {
        wave: Wave,
        #[serde(default)]
        semitones: f32,
        #[serde(default)]
        detune: f32,
        #[serde(default)]
        fixed_hz: Option<f32>,
    },
    /// AudioBufferSourceNode looping a seeded noise buffer. No ports.
    Noise { color: NoiseColor },
    /// GainNode. Port: `gain`.
    Gain { gain: f32 },
    /// BiquadFilterNode. `freq` is the cutoff at middle C; `key_track` (0..=1) scales it by
    /// (note_hz / middle_c_hz)^key_track. Ports: `freq` (Hz), `q`, `detune`.
    Filter {
        mode: FilterMode,
        freq: f32,
        q: f32,
        #[serde(default)]
        key_track: f32,
    },
    /// ConstantSourceNode driven by an ADSR (seconds). Output swings 0..=amount; connect it
    /// to a port, never to an audio input.
    Env {
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
        amount: f32,
    },
    /// WaveShaperNode with a tanh curve. `drive` 0.1..=50.
    Shaper { drive: f32 },
    /// Voice output (exactly one per instrument). A GainNode scaled by note velocity.
    Out {},
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub from: String,
    pub to: String,
    /// `None` connects to the target's audio input; otherwise the named AudioParam.
    #[serde(default)]
    pub port: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Lane {
    pub instrument: String,
    pub steps: Vec<Step>,
}

/// One pattern event. `note: Some(midi)` starts a note (replacing any note still playing in
/// the lane); `note: None` is a note-off. A note lasts until the next step in its lane or the
/// end of the loop.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub row: u32,
    #[serde(default)]
    pub note: Option<u8>,
    #[serde(default = "default_vel")]
    pub vel: u8,
}

fn default_vel() -> u8 {
    100
}

// ---------------------------------------------------------------- validation

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ValidationError {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub max_lanes: usize,
    pub max_instruments: usize,
    pub total_rows: u32,
}

pub const MAX_NODES_PER_INSTRUMENT: usize = 32;
pub const MAX_EDGES_PER_INSTRUMENT: usize = 96;
pub const MAX_ID_LEN: usize = 32;

pub fn valid_ports(kind: &NodeKind) -> &'static [&'static str] {
    match kind {
        NodeKind::Osc { .. } => &["freq", "detune"],
        NodeKind::Gain { .. } => &["gain"],
        NodeKind::Filter { .. } => &["freq", "q", "detune"],
        _ => &[],
    }
}

fn accepts_audio(kind: &NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Gain { .. } | NodeKind::Filter { .. } | NodeKind::Shaper { .. } | NodeKind::Out {}
    )
}

fn produces_audio(kind: &NodeKind) -> bool {
    !matches!(kind, NodeKind::Out {})
}

impl Orders {
    pub fn validate(&self, limits: &Limits) -> Vec<ValidationError> {
        let mut errs = Vec::new();
        let mut err = |path: String, message: String| errs.push(ValidationError { path, message });

        if self.instruments.len() > limits.max_instruments {
            err("instruments".into(), format!("at most {} instruments allowed", limits.max_instruments));
        }
        if self.lanes.len() > limits.max_lanes {
            err("lanes".into(), format!("at most {} lanes allowed", limits.max_lanes));
        }

        let mut inst_ids = HashSet::new();
        for (i, inst) in self.instruments.iter().enumerate() {
            let p = format!("instruments[{i}]");
            check_id(&inst.id, &format!("{p}.id"), &mut err);
            if !inst_ids.insert(inst.id.as_str()) {
                err(format!("{p}.id"), format!("duplicate instrument id '{}'", inst.id));
            }
            if let Some(n) = &inst.name {
                if n.chars().count() > 32 || n.chars().any(|c| c.is_control()) {
                    err(format!("{p}.name"), "name must be at most 32 characters, without control characters".into());
                }
            }
            range(inst.gain, 0.0, 1.0, &format!("{p}.gain"), &mut err);
            range(inst.send_delay, 0.0, 1.0, &format!("{p}.send_delay"), &mut err);
            range(inst.send_reverb, 0.0, 1.0, &format!("{p}.send_reverb"), &mut err);
            validate_instrument(inst, &p, &mut err);
        }

        // One track = one instrument + one lane: every lane has its own instrument and every instrument its own lane.
        let mut used = HashSet::new();
        for (i, lane) in self.lanes.iter().enumerate() {
            let p = format!("lanes[{i}]");
            if !inst_ids.contains(lane.instrument.as_str()) {
                err(format!("{p}.instrument"), format!("unknown instrument '{}'", lane.instrument));
            } else if !used.insert(lane.instrument.as_str()) {
                err(format!("{p}.instrument"), format!("instrument '{}' already has a lane (one lane per instrument)", lane.instrument));
            }
            if lane.steps.len() > limits.total_rows as usize {
                err(format!("{p}.steps"), "too many steps".into());
            }
            let mut rows = HashSet::new();
            for (j, s) in lane.steps.iter().enumerate() {
                let sp = format!("{p}.steps[{j}]");
                if s.row >= limits.total_rows {
                    err(format!("{sp}.row"), format!("row {} is outside the loop (0..{})", s.row, limits.total_rows));
                }
                if !rows.insert(s.row) {
                    err(format!("{sp}.row"), format!("duplicate step at row {}", s.row));
                }
                if let Some(n) = s.note {
                    if n > 127 {
                        err(format!("{sp}.note"), "note must be 0..=127".into());
                    }
                }
                if s.vel == 0 || s.vel > 127 {
                    err(format!("{sp}.vel"), "velocity must be 1..=127".into());
                }
            }
        }
        for (i, inst) in self.instruments.iter().enumerate() {
            if !used.contains(inst.id.as_str()) {
                err(format!("instruments[{i}]"), format!("instrument '{}' has no lane", inst.id));
            }
        }
        errs
    }
}

fn check_id(id: &str, path: &str, err: &mut impl FnMut(String, String)) {
    if id.is_empty() || id.len() > MAX_ID_LEN || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        err(path.to_string(), format!("id must be 1..={MAX_ID_LEN} chars of [A-Za-z0-9_-]"));
    }
}

fn range(v: f32, lo: f32, hi: f32, path: &str, err: &mut impl FnMut(String, String)) {
    if !v.is_finite() || v < lo || v > hi {
        err(path.to_string(), format!("must be within {lo}..={hi}"));
    }
}

fn validate_instrument(inst: &Instrument, p: &str, err: &mut impl FnMut(String, String)) {
    if inst.nodes.len() > MAX_NODES_PER_INSTRUMENT {
        err(format!("{p}.nodes"), format!("at most {MAX_NODES_PER_INSTRUMENT} nodes"));
        return;
    }
    if inst.edges.len() > MAX_EDGES_PER_INSTRUMENT {
        err(format!("{p}.edges"), format!("at most {MAX_EDGES_PER_INSTRUMENT} edges"));
        return;
    }
    let mut by_id: HashMap<&str, &NodeKind> = HashMap::new();
    let mut outs = 0;
    for (i, n) in inst.nodes.iter().enumerate() {
        let np = format!("{p}.nodes[{i}]");
        check_id(&n.id, &format!("{np}.id"), err);
        if by_id.insert(n.id.as_str(), &n.kind).is_some() {
            err(format!("{np}.id"), format!("duplicate node id '{}'", n.id));
        }
        match &n.kind {
            NodeKind::Osc { semitones, detune, fixed_hz, .. } => {
                range(*semitones, -48.0, 48.0, &format!("{np}.semitones"), err);
                range(*detune, -1200.0, 1200.0, &format!("{np}.detune"), err);
                if let Some(h) = fixed_hz {
                    range(*h, 0.01, 20000.0, &format!("{np}.fixed_hz"), err);
                }
            }
            NodeKind::Noise { .. } => {}
            // Wide on purpose: a gain node also scales modulators (an LFO into a filter cutoff needs a
            // depth in the thousands of Hz), same span as `env.amount`.
            NodeKind::Gain { gain } => range(*gain, -20000.0, 20000.0, &format!("{np}.gain"), err),
            NodeKind::Filter { freq, q, key_track, .. } => {
                range(*freq, 20.0, 20000.0, &format!("{np}.freq"), err);
                range(*q, 0.0001, 30.0, &format!("{np}.q"), err);
                range(*key_track, 0.0, 1.0, &format!("{np}.key_track"), err);
            }
            NodeKind::Env { attack, decay, sustain, release, amount } => {
                range(*attack, 0.0, 5.0, &format!("{np}.attack"), err);
                range(*decay, 0.0, 5.0, &format!("{np}.decay"), err);
                range(*sustain, 0.0, 1.0, &format!("{np}.sustain"), err);
                range(*release, 0.0, 5.0, &format!("{np}.release"), err);
                range(*amount, -20000.0, 20000.0, &format!("{np}.amount"), err);
            }
            NodeKind::Shaper { drive } => range(*drive, 0.1, 50.0, &format!("{np}.drive"), err),
            NodeKind::Out {} => outs += 1,
        }
    }
    if outs != 1 {
        err(format!("{p}.nodes"), format!("exactly one 'out' node required, found {outs}"));
    }

    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for (i, e) in inst.edges.iter().enumerate() {
        let ep = format!("{p}.edges[{i}]");
        let (Some(from), Some(to)) = (by_id.get(e.from.as_str()), by_id.get(e.to.as_str())) else {
            err(ep, "edge references a node that does not exist".into());
            continue;
        };
        match &e.port {
            None => {
                if !produces_audio(from) {
                    err(ep.clone(), "'out' has no output".into());
                }
                if matches!(from, NodeKind::Env { .. }) {
                    err(ep.clone(), "'env' can only connect to a port".into());
                }
                if !accepts_audio(to) {
                    err(ep.clone(), format!("node '{}' has no audio input", e.to));
                }
            }
            Some(port) => {
                if !valid_ports(to).contains(&port.as_str()) {
                    err(ep.clone(), format!("node '{}' has no port '{}'", e.to, port));
                }
                if matches!(from, NodeKind::Out {}) {
                    err(ep.clone(), "'out' has no output".into());
                }
            }
        }
        adj.entry(e.from.as_str()).or_default().push(e.to.as_str());
    }

    // Cycle detection (iterative DFS, colors: 0 new, 1 on stack, 2 done).
    let mut color: HashMap<&str, u8> = HashMap::new();
    for n in &inst.nodes {
        if color.get(n.id.as_str()).copied().unwrap_or(0) != 0 {
            continue;
        }
        let mut stack: Vec<(&str, usize)> = vec![(n.id.as_str(), 0)];
        color.insert(n.id.as_str(), 1);
        while let Some((cur, idx)) = stack.pop() {
            let nexts = adj.get(cur).map(|v| v.as_slice()).unwrap_or(&[]);
            if idx < nexts.len() {
                stack.push((cur, idx + 1));
                let nx = nexts[idx];
                match color.get(nx).copied().unwrap_or(0) {
                    0 => {
                        color.insert(nx, 1);
                        stack.push((nx, 0));
                    }
                    1 => {
                        err(format!("{p}.edges"), "instrument graph contains a cycle".into());
                        return;
                    }
                    _ => {}
                }
            } else {
                color.insert(cur, 2);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits { max_lanes: 4, max_instruments: 4, total_rows: 64 }
    }

    const GOOD: &str = r#"{"instruments":[{"id":"b","nodes":[{"id":"o","type":"osc","wave":"sine"},{"id":"out","type":"out"}],"edges":[{"from":"o","to":"out"}]}],
        "lanes":[{"instrument":"b","steps":[{"row":0,"note":60},{"row":4,"note":null}]}]}"#;

    #[test]
    fn parses_and_validates() {
        let o: Orders = serde_json::from_str(GOOD).unwrap();
        assert!(o.validate(&limits()).is_empty());
    }

    #[test]
    fn rejects_cycle_and_bad_rows() {
        let mut o: Orders = serde_json::from_str(GOOD).unwrap();
        o.instruments[0].nodes.push(Node { id: "g".into(), kind: NodeKind::Gain { gain: 1.0 } });
        o.instruments[0].edges.push(Edge { from: "g".into(), to: "g".into(), port: None });
        o.lanes[0].steps.push(Step { row: 64, note: Some(60), vel: 100 });
        let errs = o.validate(&limits());
        assert!(errs.iter().any(|e| e.message.contains("cycle")));
        assert!(errs.iter().any(|e| e.path.ends_with(".row")));
    }

    #[test]
    fn tracks_are_one_instrument_one_lane() {
        let mut o: Orders = serde_json::from_str(GOOD).unwrap();
        o.lanes.push(Lane { instrument: "b".into(), steps: vec![] });
        assert!(o.validate(&limits()).iter().any(|e| e.message.contains("already has a lane")));
        let mut o: Orders = serde_json::from_str(GOOD).unwrap();
        o.lanes.clear();
        assert!(o.validate(&limits()).iter().any(|e| e.message.contains("has no lane")));
    }

    #[test]
    fn instrument_name_is_optional_and_bounded() {
        let mut o: Orders = serde_json::from_str(GOOD).unwrap();
        assert!(o.instruments[0].name.is_none());
        o.instruments[0].name = Some("Wobbly bass".into());
        assert!(o.validate(&limits()).is_empty());
        o.instruments[0].name = Some("x".repeat(33));
        assert!(o.validate(&limits()).iter().any(|e| e.path.ends_with(".name")));
    }
}
