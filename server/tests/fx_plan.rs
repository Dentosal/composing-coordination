//! The effect plan (volume / arpeggio automation per note) must match the browser's `notePlan` (client/js/fx.js):
//! both are checked against the same fixture.

use band_game::orders::FxStep;
use band_game::render::{fx_plan, ParamTarget};
use std::collections::HashMap;

#[test]
fn fx_plan_matches_the_shared_fixture() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fx_plan.json")).unwrap();
    let cases: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let fx: Vec<FxStep> = serde_json::from_value(c["fx"].clone()).unwrap();
        // What the instrument offers for automation, keyed "node.port" (cases without parameter entries have none).
        let targets: HashMap<String, ParamTarget> = c["targets"].as_object().map_or_else(HashMap::new, |m| {
            m.iter()
                .map(|(k, t)| {
                    let n = |f: &str| t[f].as_f64().unwrap();
                    (k.clone(), ParamTarget { base: n("base"), factor: n("factor"), exp: t["exp"].as_bool().unwrap(), lo: n("lo"), hi: n("hi") })
                })
                .collect()
        });
        let segs = fx_plan(
            &fx,
            c["start_row"].as_u64().unwrap() as u32,
            c["end_row"].as_u64().unwrap() as u32,
            c["row_secs"].as_f64().unwrap(),
            &|node, port| targets.get(&format!("{node}.{port}")).copied(),
        );
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
            let wpar = want["params"].as_array().map_or(&[][..], |a| &a[..]);
            assert_eq!(got.params.len(), wpar.len(), "{name}: automated parameters of {got:?}");
            for (g, w) in got.params.iter().zip(wpar) {
                let label = format!("{name}: {}.{}", w["node"], w["port"]);
                assert!(g.node == w["node"].as_str().unwrap() && g.port == w["port"].as_str().unwrap(), "{label}: which parameter");
                assert_eq!(g.exp, w["exp"].as_bool().unwrap(), "{label}: exp");
                assert!(near(g.initial, w["initial"].as_f64().unwrap()), "{label}: initial {} vs {}", g.initial, w["initial"]);
                let we = w["events"].as_array().unwrap();
                assert_eq!(g.events.len(), we.len(), "{label}: events {:?} vs {}", g.events, w["events"]);
                for (ge, we) in g.events.iter().zip(we) {
                    assert!(
                        near(ge.t, we[0].as_f64().unwrap()) && near(ge.value, we[1].as_f64().unwrap()) && ge.ramp == we[2].as_bool().unwrap(),
                        "{label}: {ge:?} vs {we}"
                    );
                }
            }
        }
    }
}

#[test]
fn param_targets_match_the_shared_fixture() {
    use band_game::orders::Instrument;
    use band_game::render::param_target;
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/param_target.json")).unwrap();
    let fx: serde_json::Value = serde_json::from_str(&text).unwrap();
    let inst: Instrument = serde_json::from_value(fx["instrument"].clone()).unwrap();
    for c in fx["cases"].as_array().unwrap() {
        let got = param_target(&inst, c["hz"].as_f64().unwrap(), c["node"].as_str().unwrap(), c["port"].as_str().unwrap());
        let label = format!("{}.{} at {} Hz", c["node"], c["port"], c["hz"]);
        match (&got, &c["expected"]) {
            (None, serde_json::Value::Null) => {}
            (Some(g), w) if !w.is_null() => {
                let near = |a: f64, b: f64| (a - b).abs() < 1e-9 * b.abs().max(1.0);
                assert!(near(g.base, w["base"].as_f64().unwrap()), "{label}: base {} vs {}", g.base, w["base"]);
                assert!(near(g.factor, w["factor"].as_f64().unwrap()), "{label}: factor");
                assert_eq!(g.exp, w["exp"].as_bool().unwrap(), "{label}: exp");
                assert!(near(g.lo, w["lo"].as_f64().unwrap()) && near(g.hi, w["hi"].as_f64().unwrap()), "{label}: range");
            }
            _ => panic!("{label}: got {got:?}, want {}", c["expected"]),
        }
    }
}
