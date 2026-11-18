//! Waveshaper shapes: the curves match the browser's (shared fixture), the second setting is validated, and every shape
//! renders audibly without exploding.

use band_game::orders::{Limits, Orders, ShaperShape};
use band_game::render::voice::shaper_curve;
use band_game::render::{render, RenderConfig, SeatPart};

const LIMITS: Limits = Limits { max_lanes: 4, max_instruments: 4, total_rows: 64 };

fn shape_of(name: &str) -> ShaperShape {
    serde_json::from_value(serde_json::Value::String(name.into())).unwrap()
}

#[test]
fn curves_match_fixture() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/shaper.json")).unwrap();
    let cases: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    for c in cases {
        let shape = shape_of(c["shape"].as_str().unwrap());
        let curve = shaper_curve(shape, c["drive"].as_f64().unwrap() as f32, Some(c["param"].as_f64().unwrap() as f32));
        for pt in c["pts"].as_array().unwrap() {
            let (i, want) = (pt[0].as_u64().unwrap() as usize, pt[1].as_f64().unwrap());
            // Staircase edges (crush) can differ by one step if the two sides round a tie differently; allow none: floor on both.
            assert!((curve[i] as f64 - want).abs() < 2e-6, "{} drive {} param {} at {i}: {} vs {want}", c["shape"], c["drive"], c["param"], curve[i]);
        }
    }
}

fn orders(shaper: &str) -> Orders {
    let json = format!(
        r#"{{"instruments":[{{"id":"b","nodes":[{{"id":"o","type":"osc","wave":"sawtooth"}},{shaper},{{"id":"out","type":"out"}}],
           "edges":[{{"from":"o","to":"s"}},{{"from":"s","to":"out"}}]}}],
           "lanes":[{{"instrument":"b","steps":[{{"row":0,"note":48}},{{"row":8,"note":null}}]}}]}}"#
    );
    serde_json::from_str(&json).unwrap()
}

#[test]
fn second_setting_is_validated_and_defaults_are_omitted() {
    assert!(orders(r#"{"id":"s","type":"shaper","drive":4}"#).validate(&LIMITS).is_empty());
    assert!(orders(r#"{"id":"s","type":"shaper","drive":4,"shape":"crush","param":4}"#).validate(&LIMITS).is_empty());
    assert!(!orders(r#"{"id":"s","type":"shaper","drive":4,"shape":"crush","param":0.5}"#).validate(&LIMITS).is_empty());
    assert!(!orders(r#"{"id":"s","type":"shaper","drive":4,"shape":"crush","param":13}"#).validate(&LIMITS).is_empty());
    assert!(!orders(r#"{"id":"s","type":"shaper","drive":4,"shape":"asym","param":1.5}"#).validate(&LIMITS).is_empty());
    // A soft shaper with no param serializes exactly as before this feature.
    let o = orders(r#"{"id":"s","type":"shaper","drive":4}"#);
    let node = serde_json::to_value(&o.instruments[0].nodes[1]).unwrap();
    assert!(node.get("shape").is_none() && node.get("param").is_none(), "{node}");
}

#[test]
fn every_shape_renders() {
    let cfg = RenderConfig { bpm: 112.0, bars: 4, rows_per_bar: 16, seed: 1 };
    for shape in ["soft", "hard", "fold", "asym", "crush"] {
        for drive in [0.1, 1.0, 6.0, 50.0] {
            let o = orders(&format!(r#"{{"id":"s","type":"shaper","drive":{drive},"shape":"{shape}"}}"#));
            assert!(o.validate(&LIMITS).is_empty());
            let parts = vec![SeatPart { seat_index: 0, orders: &o }];
            let out = render(&cfg, &[parts.clone(), parts], 1);
            let peak = out.left.iter().chain(&out.right).fold(0f32, |m, x| {
                assert!(x.is_finite(), "{shape} {drive}: non-finite sample");
                m.max(x.abs())
            });
            assert!(peak > 0.005, "{shape} drive {drive}: silent");
            assert!(peak < 0.8, "{shape} drive {drive}: exploding (peak {peak})");
        }
    }
}
