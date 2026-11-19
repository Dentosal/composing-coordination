//! Song files (downloads and the finished song): the pattern plays once from silence, then rings out for up to
//! SONG_TAIL_SECS, with the trailing silence trimmed.

use band_game::orders::{Instrument, Lane, Orders, Step};
use band_game::render::{render_song, RenderConfig, SeatPart, SAMPLE_RATE, SONG_TAIL_SECS};

fn preset(name: &str) -> Instrument {
    let path = format!("{}/../client/presets/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    serde_json::from_value(v["instrument"].clone()).unwrap()
}

fn song(inst: Instrument, steps: Vec<Step>) -> (usize, usize) {
    let cfg = RenderConfig { bpm: 120.0, bars: 1, rows_per_bar: 16, seed: 1 };
    let orders = Orders { lanes: vec![Lane { instrument: inst.id.clone(), steps, fx: vec![] }], instruments: vec![inst] };
    let out = render_song(&cfg, &[vec![SeatPart { seat_index: 0, orders: &orders }]]);
    assert_eq!(out.left.len(), out.right.len());
    (cfg.loop_frames(), out.left.len())
}

#[test]
fn a_note_held_to_the_end_rings_out_and_the_silence_after_it_is_trimmed() {
    // Pad: a slow release plus reverb, held to the end of the bar.
    let (body, len) = song(preset("pad"), vec![Step { row: 0, note: Some(60), vel: 100 }]);
    let tail = (SONG_TAIL_SECS * SAMPLE_RATE as f64) as usize;
    assert!(len > body + SAMPLE_RATE as usize / 2, "the release and reverb ring past the end ({len} frames, body {body})");
    assert!(len <= body + tail);
}

#[test]
fn a_silent_song_has_no_tail() {
    let (body, len) = song(preset("pad"), vec![]);
    assert_eq!(len, body);
}
