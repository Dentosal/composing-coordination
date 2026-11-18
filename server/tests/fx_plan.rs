//! The effect plan (volume / arpeggio automation per note) must match the browser's `notePlan` (client/js/fx.js):
//! both are checked against the same fixture.

use band_game::orders::FxStep;
use band_game::render::fx_plan;

#[test]
fn fx_plan_matches_the_shared_fixture() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fx_plan.json")).unwrap();
    let cases: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let fx: Vec<FxStep> = serde_json::from_value(c["fx"].clone()).unwrap();
        let plan = fx_plan(&fx, c["start_row"].as_u64().unwrap() as u32, c["end_row"].as_u64().unwrap() as u32, c["row_secs"].as_f64().unwrap());
        let want_v = c["expected"]["volumes"].as_array().unwrap();
        let want_p = c["expected"]["pitches"].as_array().unwrap();
        assert_eq!(plan.volumes.len(), want_v.len(), "{name}: volume events");
        for (got, want) in plan.volumes.iter().zip(want_v) {
            assert!((got.0 - want[0].as_f64().unwrap()).abs() < 1e-9 && (got.1 as f64 - want[1].as_f64().unwrap()).abs() < 1e-6, "{name}: {got:?} vs {want}");
        }
        assert_eq!(plan.pitches.len(), want_p.len(), "{name}: pitch events");
        for (got, want) in plan.pitches.iter().zip(want_p) {
            assert!((got.0 - want[0].as_f64().unwrap()).abs() < 1e-9 && got.1 as i64 == want[1].as_i64().unwrap(), "{name}: {got:?} vs {want}");
        }
    }
}
