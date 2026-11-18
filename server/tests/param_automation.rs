//! Parameter automation in effect cells changes the rendered sound row by row: a cutoff entry opens the filter during its
//! row only, a glide opens it gradually, and a node parameter is addressed by node id and port.

use band_game::orders::{Limits, Orders};
use band_game::render::{render, RenderConfig, SeatPart};

const ROW_SECS: f64 = 0.125; // 120 bpm, 16 rows per bar
const SR: f64 = 48000.0;

/// A sawtooth through a dark lowpass (250 Hz), no envelopes: the sound is steady, so any change comes from the automation.
fn orders(steps: &str, fx: &str) -> Orders {
    let json = format!(
        r#"{{"instruments":[{{"id":"b","gain":1,"send_delay":0,"send_reverb":0,"nodes":[
            {{"id":"o","type":"osc","wave":"sawtooth"}},
            {{"id":"lp","type":"filter","mode":"lowpass","freq":250,"q":0.7,"key_track":0}},
            {{"id":"out","type":"out"}}],
            "edges":[{{"from":"o","to":"lp"}},{{"from":"lp","to":"out"}}]}}],
          "lanes":[{{"instrument":"b","steps":{steps},"fx":{fx}}}]}}"#
    );
    serde_json::from_str(&json).unwrap()
}

fn cutoff(row: u32, hz: f32, glide: bool) -> String {
    format!(r#"{{"row":{row},"params":[{{"node":"lp","port":"freq","value":{hz},"glide":{glide}}}]}}"#)
}

fn render_left(o: &Orders) -> Vec<f32> {
    let errs = o.validate(&Limits { max_lanes: 4, max_instruments: 4, total_rows: 16 });
    assert!(errs.is_empty(), "{errs:?}");
    let cfg = RenderConfig { bpm: 120.0, bars: 1, rows_per_bar: 16, seed: 1 };
    let parts = vec![SeatPart { seat_index: 0, orders: o }];
    render(&cfg, &[parts], 0).left
}

/// How bright a stretch of the render is: the energy of its first difference relative to its level (a sawtooth's sharp edge
/// is all high harmonics, so opening the filter raises it a lot).
fn brightness(s: &[f32], from_row: f64, to_row: f64) -> f64 {
    // The limiter delays everything by about 8 ms: shift the window by 15 ms and stay clear of the end.
    let a = (from_row * ROW_SECS * SR) as usize + 720;
    let b = ((to_row * ROW_SECS * SR) as usize + 720).min(s.len());
    let w = &s[a..b];
    let rms = |v: &mut dyn Iterator<Item = f64>| -> f64 {
        let (sum, n) = v.fold((0.0, 0usize), |(s, n), x| (s + x * x, n + 1));
        (sum / n.max(1) as f64).sqrt()
    };
    rms(&mut w.windows(2).map(|p| (p[1] - p[0]) as f64)) / rms(&mut w.iter().map(|x| *x as f64)).max(1e-9)
}

#[test]
fn a_cutoff_entry_opens_the_filter_during_its_row_only() {
    let steps = r#"[{"row":0,"note":48,"vel":100}]"#;
    let plain = render_left(&orders(steps, "[]"));
    let open = render_left(&orders(steps, &format!("[{}]", cutoff(4, 9000.0, false))));
    let (dark, bright) = (brightness(&plain, 4.0, 4.9), brightness(&open, 4.0, 4.9));
    assert!(bright > dark * 3.0, "row 4 is open: {bright} vs {dark}");
    // the rows before and after are untouched (the entry resets on the next, empty row)
    for (a, b) in [(1.0, 3.9), (5.1, 7.9), (9.0, 14.0)] {
        let (p, o) = (brightness(&plain, a, b), brightness(&open, a, b));
        assert!((o / p - 1.0).abs() < 0.1, "rows {a}..{b} are unchanged: {o} vs {p}");
    }
}

#[test]
fn a_glide_opens_the_filter_gradually_and_then_resets_at_once() {
    let steps = r#"[{"row":0,"note":48,"vel":100}]"#;
    let plain = render_left(&orders(steps, "[]"));
    let glide = render_left(&orders(steps, &format!("[{}]", cutoff(4, 9000.0, true))));
    let (start, mid, end) = (brightness(&glide, 4.0, 4.25), brightness(&glide, 4.4, 4.6), brightness(&glide, 4.75, 4.98));
    assert!(start < mid && mid < end, "brighter and brighter along the row: {start} < {mid} < {end}");
    assert!(end > start * 2.0, "{end} vs {start}");
    let after = brightness(&glide, 5.3, 5.9);
    let dark = brightness(&plain, 5.3, 5.9);
    assert!(after < dark * 1.3, "the next row is back at the node's own cutoff: {after} vs {dark}");
}

#[test]
fn the_state_belongs_to_the_rows_not_to_the_notes() {
    // Two notes; the entry is on row 6, inside the second note: only that row opens, the note's other rows stay dark.
    let steps = r#"[{"row":0,"note":48,"vel":100},{"row":4,"note":55,"vel":100}]"#;
    let plain = render_left(&orders(steps, "[]"));
    let open = render_left(&orders(steps, &format!("[{}]", cutoff(6, 9000.0, false))));
    assert!(brightness(&open, 6.0, 6.9) > brightness(&plain, 6.0, 6.9) * 3.0, "row 6 opens");
    for (a, b) in [(4.1, 5.9), (7.1, 9.9)] {
        let (p, o) = (brightness(&plain, a, b), brightness(&open, a, b));
        assert!((o / p - 1.0).abs() < 0.1, "rows {a}..{b} stay as they were: {o} vs {p}");
    }
}

#[test]
fn an_entry_a_retrigger_splits_still_applies_to_every_voice() {
    let steps = r#"[{"row":0,"note":48,"vel":100}]"#;
    let fx = r#"[{"row":4,"retrig":2,"params":[{"node":"lp","port":"freq","value":9000}]}]"#;
    let plain = render_left(&orders(steps, "[]"));
    let split = render_left(&orders(steps, fx));
    assert!(brightness(&split, 4.0, 4.9) > brightness(&plain, 4.0, 4.9) * 3.0, "every retriggered voice of the row has the open filter");
}

#[test]
fn validation_refuses_entries_the_instrument_cannot_take() {
    let steps = r#"[{"row":0,"note":48,"vel":100}]"#;
    let bad = |fx: &str| {
        let o = orders(steps, fx);
        !o.validate(&Limits { max_lanes: 4, max_instruments: 4, total_rows: 16 }).is_empty()
    };
    assert!(!bad(&format!("[{}]", cutoff(2, 1000.0, false))));
    assert!(bad(r#"[{"row":2,"params":[{"node":"nope","port":"freq","value":1000}]}]"#), "no such node");
    assert!(bad(r#"[{"row":2,"params":[{"node":"o","port":"freq","value":440}]}]"#), "an ordinary oscillator's pitch is not automatable");
    assert!(bad(&format!("[{}]", cutoff(2, 5.0, false))), "outside the cutoff's range");
}
