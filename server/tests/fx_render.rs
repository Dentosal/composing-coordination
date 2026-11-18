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

fn fx_cell(row: u32, volume: Option<f32>, arp: Option<Vec<i32>>) -> FxStep {
    FxStep { row, volume, arp: arp.map(|offsets| Arp { offsets }), slide: None, cut: None, retrig: None, params: vec![] }
}

fn render_with(fx: Vec<FxStep>) -> Vec<f32> {
    render_note(48, fx)
}

fn render_note(note: u8, fx: Vec<FxStep>) -> Vec<f32> {
    let inst = organ();
    let steps = vec![Step { row: 0, note: Some(note), vel: 100 }];
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
    let quiet = render_with(vec![fx_cell(4, Some(0.0), None), fx_cell(5, Some(0.5), None)]);
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
    let up = render_with(vec![fx_cell(3, None, Some(vec![12]))]);
    let ratio = crossings(&seg(3, &up)) as f64 / crossings(&seg(3, &plain)) as f64;
    assert!(ratio > 1.85 && ratio < 2.15, "an octave up doubles the pitch, got {ratio}");
    assert_eq!(crossings(&seg(2, &up)), crossings(&seg(2, &plain)), "rows before are unchanged");
    let back = crossings(&seg(4, &up)) as f64 / crossings(&seg(4, &plain)) as f64;
    assert!((back - 1.0).abs() < 0.03, "the pitch is back after the arpeggio row, got {back}");
    // Two offsets alternate every tick (six per row): about the average of the two pitches.
    let alt = render_with(vec![fx_cell(3, None, Some(vec![0, 12]))]);
    let mix = crossings(&seg(3, &alt)) as f64 / crossings(&seg(3, &plain)) as f64;
    assert!(mix > 1.3 && mix < 1.7, "alternating an octave averages out to about 1.5x, got {mix}");
}

fn with(row: u32, f: impl Fn(&mut FxStep)) -> FxStep {
    let mut c = fx_cell(row, None, None);
    f(&mut c);
    c
}

#[test]
fn slide_moves_the_pitch_and_it_stays() {
    let secs = 0.125;
    let sr = 48000.0;
    let seg = |row: usize, s: &[f32]| s[(row as f64 * secs * sr) as usize + 720..((row + 1) as f64 * secs * sr) as usize - 300].to_vec();
    let plain = render_with(vec![]);
    let up = render_with(vec![with(2, |c| c.slide = Some(12))]); // an octave up over row 2
    let at = |row: usize| crossings(&seg(row, &up)) as f64 / crossings(&seg(row, &plain)) as f64;
    assert!((at(1) - 1.0).abs() < 0.03, "before the slide: {}", at(1));
    assert!(at(2) > 1.2 && at(2) < 1.9, "during the slide the pitch rises: {}", at(2));
    assert!((at(3) - 2.0).abs() < 0.1, "after the slide it stays an octave up: {}", at(3));
    assert!((at(5) - 2.0).abs() < 0.1, "and stays: {}", at(5));
    let down = render_with(vec![with(2, |c| c.slide = Some(-12))]);
    let d = crossings(&seg(4, &down)) as f64 / crossings(&seg(4, &plain)) as f64;
    assert!((d - 0.5).abs() < 0.05, "slide down an octave halves the pitch: {d}");
}

#[test]
fn cut_silences_the_note_from_its_tick() {
    let secs = 0.125;
    let sr = 48000.0;
    let seg = |from: f64, to: f64, s: &[f32]| s[(from * secs * sr) as usize..(to * secs * sr) as usize].to_vec();
    let cut = render_with(vec![with(3, |c| c.cut = Some(3))]); // halfway through row 3
    assert!(rms(&seg(3.0 + 0.0, 3.0 + 0.4, &cut)) > 0.005, "sounds before the cut");
    assert!(rms(&seg(3.5 + 0.2, 6.0, &cut)) < 1e-4, "silent after the cut");
    let plain = render_with(vec![]);
    assert!(rms(&seg(3.5 + 0.2, 6.0, &plain)) > 0.005, "the uncut note carries on");
}

/// The quietest 2 ms window between `from` and `to` seconds.
fn min_window_rms(s: &[f32], from: f64, to: f64) -> f64 {
    let sr = 48000.0;
    let win = (0.002 * sr) as usize;
    let (a, b) = ((from * sr) as usize, (to * sr) as usize);
    (a..b - win).step_by(24).map(|i| rms(&s[i..i + win])).fold(f64::MAX, f64::min)
}

#[test]
fn retrigger_restarts_the_note() {
    let secs = 0.125;
    // A high note (many cycles per millisecond) keeps short-window levels steady.
    let plain = render_note(96, vec![]);
    let re = render_note(96, vec![with(2, |c| c.retrig = Some(2))]); // restarts at ticks 2 and 4 of row 2
    // The old voice is silenced at the instant of a restart and the new one fades in, so the level dips there
    // (the limiter delays everything by about 8 ms). A plain note has no such dip.
    let restart = (2.0 + 2.0 / 6.0) * secs;
    let (from, to) = (restart, restart + 0.03);
    let steady = min_window_rms(&plain, from, to);
    let dip = min_window_rms(&re, from, to);
    assert!(steady > 0.03, "the plain note sounds: {steady}");
    assert!(dip < steady * 0.4, "the retriggered note dips at the restart: {dip} vs {steady}");
    let rows_after = rms(&re[(4.0 * secs * 48000.0) as usize..(5.0 * secs * 48000.0) as usize]);
    assert!(rows_after > steady * 0.8, "it sounds again after the retriggered row: {rows_after}");
}
