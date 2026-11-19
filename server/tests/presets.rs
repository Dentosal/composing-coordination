//! Every shipped preset must render to finite, audible, non-exploding audio, including long held
//! notes. Guards against the web-audio-api setTarget bug worked around in `schedule_env`.

use band_game::orders::{Instrument, Lane, Limits, Orders, Step};
use band_game::render::{render, RenderConfig, SeatPart};

#[test]
fn presets_render_sanely_with_held_notes() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../client/presets");
    let names: Vec<String> = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/index.json")).unwrap()).unwrap();
    let cfg = RenderConfig { bpm: 112.0, bars: 4, rows_per_bar: 16, seed: 1 };
    // One thread per preset: rendering is the slow part, and each preset is independent. A failing
    // preset's assertion message is printed by its thread, and the scope then fails the test.
    let cfg = &cfg;
    std::thread::scope(|scope| {
        for name in &names {
            scope.spawn(move || check_preset(dir, name, cfg));
        }
    });
}

fn check_preset(dir: &str, name: &str, cfg: &RenderConfig) {
    let text = std::fs::read_to_string(format!("{dir}/{name}.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let inst: Instrument = serde_json::from_value(v["instrument"].clone()).unwrap();
    // A note held for 8 rows, and a single-row note.
    let steps = vec![
        Step { row: 0, note: Some(48), vel: 100 },
        Step { row: 8, note: Some(48), vel: 100 },
        Step { row: 9, note: None, vel: 100 },
        Step { row: 32, note: Some(48), vel: 100 },
    ];
    let orders = Orders { lanes: vec![Lane { instrument: inst.id.clone(), steps, fx: vec![] }], instruments: vec![inst] };
    let errs = orders.validate(&Limits { max_lanes: 4, max_instruments: 4, total_rows: 64 });
    assert!(errs.is_empty(), "{name}: preset fails server validation: {errs:?}");
    let parts = vec![SeatPart { seat_index: 0, orders: &orders }];
    let out = render(cfg, &[parts.clone(), parts], 1);
    let peak = out.left.iter().chain(&out.right).fold(0f32, |m, x| {
        assert!(x.is_finite(), "{name}: non-finite sample");
        m.max(x.abs())
    });
    assert!(peak > 0.005, "{name}: silent (peak {peak})");
    assert!(peak < 0.5, "{name}: exploding (peak {peak})");
}
