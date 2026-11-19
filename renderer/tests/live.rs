//! Live playback (render::live): plays like a song render, loops its region, takes edits while it runs, and stops.

use band_render::orders::{Instrument, Lane, Orders, Step};
use band_render::render::live::{run, Command, LivePart, Transport};
use band_render::render::{render_song, RenderConfig, SeatPart};

fn preset(name: &str) -> Instrument {
    let path = format!("{}/../client/presets/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    serde_json::from_value(v["instrument"].clone()).unwrap()
}

fn song() -> Orders {
    let (pad, hat, bass) = (preset("pad"), preset("hat"), preset("bass"));
    Orders {
        lanes: vec![
            Lane { instrument: pad.id.clone(), steps: vec![Step { row: 0, note: Some(60), vel: 100 }, Step { row: 16, note: Some(64), vel: 100 }], fx: vec![] },
            Lane { instrument: hat.id.clone(), steps: (0..32).step_by(2).map(|r| Step { row: r, note: Some(60), vel: 100 }).collect(), fx: vec![] },
            Lane {
                instrument: bass.id.clone(),
                steps: vec![Step { row: 0, note: Some(36), vel: 110 }, Step { row: 6, note: None, vel: 100 }, Step { row: 8, note: Some(43), vel: 100 }],
                fx: vec![],
            },
        ],
        instruments: vec![pad, hat, bass],
    }
}

const CFG: RenderConfig = RenderConfig { bpm: 120.0, bars: 2, rows_per_bar: 16, seed: 3 };

/// Run live, collecting the left channel, until `frames` have been played (then stop).
fn play(transport: Transport, parts: Vec<LivePart>, frames: usize, mut commands: Vec<(usize, Command)>) -> Vec<f32> {
    let mut out = Vec::new();
    let produced = std::cell::Cell::new(0usize);
    let mut poll = || {
        let at = produced.get();
        if at >= frames {
            return Some(Command { stop: true, ..Default::default() });
        }
        if commands.first().is_some_and(|(f, _)| *f <= at) {
            return Some(commands.remove(0).1);
        }
        None
    };
    let mut sink = |l: &[f32], _r: &[f32]| {
        out.extend_from_slice(l);
        produced.set(produced.get() + l.len());
    };
    run(&CFG, transport, parts, &mut poll, &mut sink);
    out
}

#[test]
fn rows_play_from_the_start_to_the_loop_end_then_the_region_over_and_over() {
    let t = Transport { start: 5, loop_start: 4, loop_end: 8 };
    let rows: Vec<u32> = (0..9).map(|k| t.row(k)).collect();
    assert_eq!(rows, vec![5, 6, 7, 4, 5, 6, 7, 4, 5]);
}

#[test]
fn one_pass_sounds_like_the_song_render() {
    let orders = song();
    let rendered = render_song(&CFG, &[vec![SeatPart { seat_index: 0, orders: &orders }]]);
    let total = CFG.loop_frames();
    let live = play(Transport { start: 0, loop_start: 0, loop_end: CFG.total_rows() }, vec![LivePart { seat: 0, orders: song() }], total + 512, vec![]);
    let max = (0..total).map(|i| (live[i] - rendered.left[i]).abs()).fold(0f32, f32::max);
    let peak = rendered.left[..total].iter().fold(0f32, |m, x| m.max(x.abs()));
    assert!(peak > 0.05, "audible: {peak}");
    assert!(max < 1e-4, "the same audio, to rounding: max difference {max}");
}

#[test]
fn an_edit_is_heard_from_the_next_rows_and_stop_ends_the_run() {
    let row = (CFG.row_secs() * 48000.0) as usize;
    let silent = Orders { lanes: vec![], instruments: vec![] };
    // Start with nothing; after four rows, send the song.
    let edit = 4 * row;
    let live = play(
        Transport { start: 0, loop_start: 0, loop_end: CFG.total_rows() },
        vec![LivePart { seat: 0, orders: silent }],
        12 * row,
        vec![(edit, Command { parts: Some(vec![LivePart { seat: 0, orders: song() }]), stop: false })],
    );
    let before = live[..edit].iter().fold(0f32, |m, x| m.max(x.abs()));
    let after = live[edit..].iter().fold(0f32, |m, x| m.max(x.abs()));
    assert_eq!(before, 0.0, "nothing plays before the edit");
    assert!(after > 0.05, "the edit is heard: {after}");
    // It stops within a few quanta of being asked to.
    assert!(live.len() >= 12 * row && live.len() < 12 * row + 8 * 128, "stopped at {} frames", live.len());
}
