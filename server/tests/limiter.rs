//! The master limiter is a static curve, identical to the browser's (shared fixture), so it adds no delay: a note
//! starts exactly on its row.

use band_game::orders::{Instrument, Lane, Orders, Step};
use band_game::render::master::{limiter_curve, LIMIT_CURVE_LEN};
use band_game::render::{render, RenderConfig, SeatPart, SAMPLE_RATE};

#[test]
fn curve_matches_the_browser() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/limiter.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let curve = limiter_curve();
    assert_eq!(curve.len(), v["len"].as_u64().unwrap() as usize);
    assert_eq!(curve.len(), LIMIT_CURVE_LEN);
    for pt in v["pts"].as_array().unwrap() {
        let (i, want) = (pt[0].as_u64().unwrap() as usize, pt[1].as_f64().unwrap());
        assert_eq!(curve[i] as f64, want, "at {i}");
    }
}

#[test]
fn a_note_starts_exactly_on_its_row() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../client/presets/hat.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let inst: Instrument = serde_json::from_value(v["instrument"].clone()).unwrap();
    let orders = Orders {
        lanes: vec![Lane { instrument: inst.id.clone(), steps: vec![Step { row: 4, note: Some(60), vel: 127 }], fx: vec![] }],
        instruments: vec![inst],
    };
    let cfg = RenderConfig { bpm: 112.0, bars: 1, rows_per_bar: 16, seed: 1 };
    let out = render(&cfg, &[vec![SeatPart { seat_index: 0, orders: &orders }]], 0);
    let due = (4.0 * cfg.row_secs() * SAMPLE_RATE as f64).ceil() as usize;
    let first = out.left.iter().position(|x| *x != 0.0).expect("audible");
    assert!(first >= due && first <= due + 2, "first sample {first}, due at {due}");
}
