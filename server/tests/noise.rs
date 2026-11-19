//! Every noise colour validates and renders to finite, audible audio at a sensible level.

use band_game::orders::{Instrument, Lane, Limits, Orders, Step};
use band_game::render::{render, RenderConfig, SeatPart};

/// The Init preset with its oscillators silenced and only noise of `color` sounding: (rms, peak) of the render.
fn render_noise(color: &str) -> (f32, f32) {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../client/presets/init.json");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for node in v["instrument"]["nodes"].as_array_mut().unwrap() {
        match node["id"].as_str().unwrap() {
            "n" => node["color"] = color.into(),
            "ln" => node["gain"] = 1.0.into(),
            "l1" | "l2" | "l3" => node["gain"] = 0.0.into(),
            "lp" => node["freq"] = 20000.0.into(), // the filter wide open, so the colours are compared unfiltered
            _ => {}
        }
    }
    let inst: Instrument = serde_json::from_value(v["instrument"].clone()).unwrap();
    let steps = vec![Step { row: 0, note: Some(60), vel: 100 }];
    let orders = Orders { lanes: vec![Lane { instrument: inst.id.clone(), steps, fx: vec![] }], instruments: vec![inst] };
    let errs = orders.validate(&Limits { max_lanes: 4, max_instruments: 4, total_rows: 16 });
    assert!(errs.is_empty(), "{color}: {errs:?}");
    let cfg = RenderConfig { bpm: 120.0, bars: 1, rows_per_bar: 16, seed: 1 };
    let out = render(&cfg, &[vec![SeatPart { seat_index: 0, orders: &orders }]], 0);
    assert!(out.left.iter().all(|x| x.is_finite()), "{color}: non-finite sample");
    let rms = (out.left.iter().map(|x| x * x).sum::<f32>() / out.left.len() as f32).sqrt();
    (rms, out.left.iter().fold(0f32, |m, x| m.max(x.abs())))
}

#[test]
fn every_noise_colour_renders_at_a_similar_level() {
    let levels: Vec<_> = ["white", "pink", "brown"].iter().map(|c| (c, render_noise(c))).collect();
    let pink = levels[1].1 .0;
    for (color, (rms, peak)) in &levels {
        assert!(*peak > 0.01 && *peak < 1.0, "{color}: peak {peak}");
        // brown is scaled to about pink's loudness, so switching colour doesn't jump in level
        assert!(*rms > pink / 3.0 && *rms < pink * 3.0, "{color}: rms {rms} vs pink {pink}");
    }
}
