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
        let segs = fx_plan(&fx, c["start_row"].as_u64().unwrap() as u32, c["end_row"].as_u64().unwrap() as u32, c["row_secs"].as_f64().unwrap());
        let want = c["expected"].as_array().unwrap();
        assert_eq!(segs.len(), want.len(), "{name}: segments");
        let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
        for (got, want) in segs.iter().zip(want) {
            assert!(near(got.start, want["start"].as_f64().unwrap()) && near(got.end, want["end"].as_f64().unwrap()), "{name}: segment {got:?} vs {want}");
            let (wv, wp) = (want["volumes"].as_array().unwrap(), want["pitches"].as_array().unwrap());
            assert_eq!(got.volumes.len(), wv.len(), "{name}: volume events");
            for (g, w) in got.volumes.iter().zip(wv) {
                assert!(near(g.0, w[0].as_f64().unwrap()) && (g.1 as f64 - w[1].as_f64().unwrap()).abs() < 1e-6, "{name}: {g:?} vs {w}");
            }
            assert_eq!(got.pitches.len(), wp.len(), "{name}: pitch events");
            for (g, w) in got.pitches.iter().zip(wp) {
                assert!(near(g.0, w[0].as_f64().unwrap()) && near(g.1, w[1].as_f64().unwrap()), "{name}: {g:?} vs {w}");
            }
        }
    }
}
