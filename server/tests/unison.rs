//! Unison oscillators: offsets match the shared fixture (the browser checks the same file), limits are enforced,
//! and a unison patch renders audibly, about as loud as a plain one (1/sqrt(n) compensation).

use band_game::orders::{unison_offsets, Limits, Orders};
use band_game::render::{render, RenderConfig, SeatPart};

#[test]
fn offsets_match_fixture() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/unison.json")).unwrap();
    let cases: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    for c in cases {
        let want: Vec<f32> = c["offsets"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
        let got = unison_offsets(c["n"].as_u64().unwrap() as u8, c["spread"].as_f64().unwrap() as f32);
        assert_eq!(got, want, "{c}");
    }
}

fn orders(extra: &str) -> Orders {
    let json = format!(
        r#"{{"instruments":[{{"id":"b","nodes":[{{"id":"o","type":"osc","wave":"sawtooth"{extra}}},{{"id":"out","type":"out"}}],"edges":[{{"from":"o","to":"out"}}]}}],
        "lanes":[{{"instrument":"b","steps":[{{"row":0,"note":48}},{{"row":8,"note":null}}]}}]}}"#
    );
    serde_json::from_str(&json).unwrap()
}

const LIMITS: Limits = Limits { max_lanes: 4, max_instruments: 4, total_rows: 64 };

#[test]
fn limits_are_enforced() {
    assert!(orders(r#","unison":7,"spread":100"#).validate(&LIMITS).is_empty());
    assert!(!orders(r#","unison":0"#).validate(&LIMITS).is_empty());
    assert!(!orders(r#","unison":8"#).validate(&LIMITS).is_empty());
    assert!(!orders(r#","spread":101"#).validate(&LIMITS).is_empty());
    assert!(!orders(r#","spread":-1"#).validate(&LIMITS).is_empty());
}

#[test]
fn unison_renders_with_comparable_level() {
    let cfg = RenderConfig { bpm: 112.0, bars: 4, rows_per_bar: 16, seed: 1 };
    // RMS, not peak: the copies all start in phase, so the first instants peak at up to sqrt(n) times a plain note
    // before they drift apart. 1/sqrt(n) keeps the average loudness (uncorrelated copies) about equal.
    let rms = |o: &Orders| {
        let parts = vec![SeatPart { seat_index: 0, orders: o }];
        let out = render(&cfg, &[parts.clone(), parts], 1);
        let sum: f64 = out.left.iter().chain(&out.right).map(|x| {
            assert!(x.is_finite());
            (*x as f64).powi(2)
        }).sum();
        (sum / (out.left.len() + out.right.len()) as f64).sqrt() as f32
    };
    let plain = rms(&orders(""));
    let uni = rms(&orders(r#","unison":7,"spread":25"#));
    assert!(plain > 0.001 && uni > 0.001, "silent: {plain} {uni}");
    assert!(uni < plain * 1.6 && uni > plain * 0.6, "level jumped: plain {plain}, unison {uni}");
}

#[test]
fn wave_tables_match_fixture() {
    use band_game::orders::Wave;
    use band_game::render::voice::{unison_harmonics, unison_phase, wave_coeffs};
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/unison_wave.json")).unwrap();
    let fx: serde_json::Value = serde_json::from_str(&text).unwrap();
    for c in fx["coeffs"].as_array().unwrap() {
        let wave = match c["wave"].as_str().unwrap() {
            "sine" => Wave::Sine,
            "square" => Wave::Square,
            "sawtooth" => Wave::Sawtooth,
            _ => Wave::Triangle,
        };
        let (real, imag) = wave_coeffs(wave, c["harmonics"].as_u64().unwrap() as usize, c["phase"].as_f64().unwrap());
        for (key, got) in [("real", real), ("imag", imag)] {
            let want: Vec<f64> = c[key].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            assert_eq!(got.len(), want.len());
            for (g, w) in got.iter().zip(&want) {
                assert!((*g as f64 - w).abs() < 1e-6, "{} {key}: {g} vs {w}", c["wave"]);
            }
        }
    }
    for (n, ph) in fx["phases"].as_object().unwrap() {
        for (i, v) in ph.as_array().unwrap().iter().enumerate() {
            assert_eq!(unison_phase(i, n.parse().unwrap()), v.as_f64().unwrap(), "n={n} i={i}");
        }
    }
    for h in fx["harmonics"].as_array().unwrap() {
        assert_eq!(unison_harmonics(h["hz"].as_f64().unwrap()), h["harmonics"].as_u64().unwrap() as usize, "{h}");
    }
}

#[test]
fn unison_start_of_note_is_not_louder_than_the_rest() {
    let cfg = RenderConfig { bpm: 112.0, bars: 4, rows_per_bar: 16, seed: 1 };
    let o = orders(r#","unison":7,"spread":25"#);
    let parts = vec![SeatPart { seat_index: 0, orders: &o }];
    let out = render(&cfg, &[parts.clone(), parts], 1);
    let peak = |a: &[f32]| a.iter().fold(0f32, |m, x| m.max(x.abs()));
    // The note starts at 0 and is held for 8 rows (about 0.54 s at 112 bpm, 4 rows per beat).
    let start = peak(&out.left[..2400]); // first 50 ms
    let later = peak(&out.left[9600..19200]); // 200..400 ms
    assert!(start < later * 1.3, "onset spike: first 50 ms peak {start}, later {later}");
}
