//! Gain `key_track` (the pitch-following depth FM relies on) and an FM patch (osc 2 -> gain -> osc 1 `freq`).

use band_game::orders::{Limits, Orders};
use band_game::render::{render, RenderConfig, SeatPart};

const LIMITS: Limits = Limits { max_lanes: 4, max_instruments: 4, total_rows: 64 };

fn orders(nodes: &str, edges: &str, note: u8) -> Orders {
    let json = format!(
        r#"{{"instruments":[{{"id":"b","nodes":[{nodes},{{"id":"out","type":"out"}}],"edges":[{edges}]}}],
        "lanes":[{{"instrument":"b","steps":[{{"row":0,"note":{note}}},{{"row":8,"note":null}}]}}]}}"#
    );
    serde_json::from_str(&json).unwrap()
}

fn samples(o: &Orders) -> Vec<f32> {
    assert!(o.validate(&LIMITS).is_empty(), "{:?}", o.validate(&LIMITS));
    let cfg = RenderConfig { bpm: 112.0, bars: 4, rows_per_bar: 16, seed: 1 };
    let parts = vec![SeatPart { seat_index: 0, orders: o }];
    let out = render(&cfg, &[parts.clone(), parts], 1);
    out.left.iter().zip(&out.right).flat_map(|(l, r)| [*l, *r]).inspect(|x| assert!(x.is_finite())).collect()
}

fn rms(v: &[f32]) -> f64 {
    (v.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}

#[test]
fn gain_key_track_scales_with_pitch() {
    // A quiet sine through a gain node: key_track 1 doubles the gain an octave above middle C and leaves middle C alone.
    let level = |note: u8, key_track: f32| {
        let nodes = format!(r#"{{"id":"o","type":"osc","wave":"sine","fixed_hz":440}},{{"id":"g","type":"gain","gain":0.5,"key_track":{key_track}}}"#);
        rms(&samples(&orders(&nodes, r#"{"from":"o","to":"g"},{"from":"g","to":"out"}"#, note)))
    };
    let (c4_tracked, c4_plain) = (level(60, 1.0), level(60, 0.0));
    assert!((c4_tracked / c4_plain - 1.0).abs() < 0.02, "middle C: {c4_tracked} vs {c4_plain}");
    let (c5_tracked, c5_plain) = (level(72, 1.0), level(72, 0.0));
    assert!((c5_tracked / c5_plain - 2.0).abs() < 0.15, "octave up: {c5_tracked} vs {c5_plain}");
}

#[test]
fn key_track_range_is_validated() {
    let bad = |kt: f32| {
        let nodes = format!(r#"{{"id":"g","type":"gain","gain":1,"key_track":{kt}}}"#);
        !orders(&nodes, "", 60).validate(&LIMITS).is_empty()
    };
    assert!(!bad(0.0) && !bad(1.0));
    assert!(bad(-0.1) && bad(1.1));
}

#[test]
fn fm_patch_renders_and_changes_the_sound() {
    let fm = |depth_gain: f32| {
        let nodes = format!(
            r#"{{"id":"o1","type":"osc","wave":"sine"}},{{"id":"o2","type":"osc","wave":"sine","semitones":12}},
               {{"id":"fm","type":"gain","gain":{depth_gain},"key_track":1}}"#
        );
        samples(&orders(&nodes, r#"{"from":"o2","to":"fm"},{"from":"fm","to":"o1","port":"freq"},{"from":"o1","to":"out"}"#, 48))
    };
    let (plain, modulated) = (fm(0.0), fm(1500.0));
    assert!(rms(&plain) > 0.005 && rms(&modulated) > 0.005);
    // FM spreads the energy into sidebands: the waveform differs a lot from the plain sine.
    let diff: Vec<f32> = plain.iter().zip(&modulated).map(|(a, b)| a - b).collect();
    assert!(rms(&diff) > rms(&plain) * 0.5, "FM did not change the sound: diff {} vs {}", rms(&diff), rms(&plain));
}
