//! Effects change the rendered sound: a volume of 0 silences its rows, an arpeggio moves the pitch.

use band_game::orders::{Arp, FxStep, Instrument, Lane, Orders, Step};
use band_game::render::{render, RenderConfig, SeatPart};

fn cfg() -> RenderConfig {
    RenderConfig { bpm: 120.0, bars: 1, rows_per_bar: 16, seed: 1 }
}

fn organ() -> Instrument {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../client/presets/organ.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let mut inst: Instrument = serde_json::from_value(v["instrument"].clone()).unwrap();
    inst.send_delay = 0.0; // no echo or reverb tails, so a silenced row is really silent
    inst.send_reverb = 0.0;
    inst
}

fn render_with(fx: Vec<FxStep>) -> Vec<f32> {
    let inst = organ();
    let steps = vec![Step { row: 0, note: Some(48), vel: 100 }];
    let orders = Orders { lanes: vec![Lane { instrument: inst.id.clone(), steps, fx }], instruments: vec![inst] };
    let parts = vec![SeatPart { seat_index: 0, orders: &orders }];
    let out = render(&cfg(), &[parts], 0);
    out.left
}

fn rms(s: &[f32]) -> f64 {
    (s.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / s.len().max(1) as f64).sqrt()
}

/// Number of zero crossings: a rough pitch measure.
fn crossings(s: &[f32]) -> usize {
    s.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count()
}

#[test]
fn volume_zero_silences_its_rows_and_half_volume_halves_them() {
    let secs = 0.125; // a row at 120 bpm, 16 rows per bar
    let sr = 48000.0;
    // The limiter delays everything by about 8 ms, so skip the first 15 ms of a row (the previous row's tail).
    let seg = |rows: std::ops::Range<usize>, s: &[f32]| s[(rows.start as f64 * secs * sr) as usize + 720..(rows.end as f64 * secs * sr) as usize - 200].to_vec();
    let plain = render_with(vec![]);
    let quiet = render_with(vec![FxStep { row: 4, volume: Some(0.0), arp: None }, FxStep { row: 5, volume: Some(0.5), arp: None }]);
    assert!(rms(&seg(4..5, &plain)) > 0.005, "the note sounds");
    assert!(rms(&seg(4..5, &quiet)) < 1e-4, "volume 0 is silent");
    let ratio = rms(&seg(5..6, &quiet)) / rms(&seg(5..6, &plain));
    assert!((ratio - 0.5).abs() < 0.08, "volume 0.5 halves the level, got {ratio}");
    assert!((rms(&seg(2..3, &quiet)) / rms(&seg(2..3, &plain)) - 1.0).abs() < 0.02, "other rows are untouched");
}

#[test]
fn arpeggio_changes_the_pitch_during_its_row_and_only_then() {
    let secs = 0.125;
    let sr = 48000.0;
    let seg = |row: usize, s: &[f32]| s[(row as f64 * secs * sr) as usize + 720..((row + 1) as f64 * secs * sr) as usize - 300].to_vec();
    let plain = render_with(vec![]);
    // One offset of an octave: every tick of the row is an octave up, so the row has twice the zero crossings.
    let up = render_with(vec![FxStep { row: 3, volume: None, arp: Some(Arp { offsets: vec![12] }) }]);
    let ratio = crossings(&seg(3, &up)) as f64 / crossings(&seg(3, &plain)) as f64;
    assert!(ratio > 1.85 && ratio < 2.15, "an octave up doubles the pitch, got {ratio}");
    assert_eq!(crossings(&seg(2, &up)), crossings(&seg(2, &plain)), "rows before are unchanged");
    let back = crossings(&seg(4, &up)) as f64 / crossings(&seg(4, &plain)) as f64;
    assert!((back - 1.0).abs() < 0.03, "the pitch is back after the arpeggio row, got {back}");
    // Two offsets alternate every tick (six per row): about the average of the two pitches.
    let alt = render_with(vec![FxStep { row: 3, volume: None, arp: Some(Arp { offsets: vec![0, 12] }) }]);
    let mix = crossings(&seg(3, &alt)) as f64 / crossings(&seg(3, &plain)) as f64;
    assert!(mix > 1.3 && mix < 1.7, "alternating an octave averages out to about 1.5x, got {mix}");
}
