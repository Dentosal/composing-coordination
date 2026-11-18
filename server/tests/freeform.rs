//! Freeform mode: one person, no game.

use band_game::state::{Config, Session, UNLIMITED_TRACK_CAP};

#[test]
fn a_freeform_session_has_one_seat_and_unlimited_tracks() {
    let cfg: Config = serde_json::from_str(r#"{"freeform":true,"bpm":90,"bars":2,"rows_per_bar":8,"seed":7}"#).unwrap();
    assert!(cfg.validate().is_ok());
    assert_eq!(cfg.limits().max_lanes, UNLIMITED_TRACK_CAP);
    let mut s = Session::new(cfg);
    assert!(s.join().is_ok(), "the first person takes the seat");
    assert!(s.join().is_err(), "nobody else can join");

    let mut game = Session::new(Config::default());
    assert!(game.join().is_ok() && game.join().is_ok(), "a normal session takes more players");
}

#[test]
fn only_freeform_sessions_can_change_their_length() {
    use band_game::state::MAX_FREEFORM_BARS;
    let mut game = Session::new(Config::default());
    assert!(game.set_bars(8).is_err(), "a game has a fixed length");

    let cfg: Config = serde_json::from_str(r#"{"freeform":true,"rows_per_bar":16}"#).unwrap();
    let mut s = Session::new(cfg);
    assert!(s.set_bars(MAX_FREEFORM_BARS).is_ok());
    assert!(s.set_bars(MAX_FREEFORM_BARS + 1).is_err());
    assert!(s.set_bars(0).is_err());
    assert_eq!(s.config.bars, MAX_FREEFORM_BARS);

    // a freeform loop may be longer than a game's 16 bars; a game may not
    assert!(serde_json::from_str::<Config>(r#"{"freeform":true,"bars":40}"#).unwrap().validate().is_ok());
    assert!(serde_json::from_str::<Config>(r#"{"bars":40}"#).unwrap().validate().is_err());
}

#[test]
fn the_seed_is_sent_as_text_so_big_seeds_survive_the_browser() {
    // 9341554369522371407 is not exactly representable as a JSON number in a browser
    let big = "9341554369522371407";
    let from_number: Config = serde_json::from_str(&format!(r#"{{"seed":{big}}}"#)).unwrap();
    let from_text: Config = serde_json::from_str(&format!(r#"{{"seed":"{big}"}}"#)).unwrap();
    assert_eq!(from_number.seed, 9341554369522371407);
    assert_eq!(from_text.seed, from_number.seed);
    let out = serde_json::to_value(&from_text).unwrap();
    assert_eq!(out["seed"], serde_json::json!(big), "written as a string, digits intact");
    assert!(serde_json::from_str::<Config>(r#"{"seed":"abc"}"#).is_err());
    assert!(serde_json::from_str::<Config>(r#"{"seed":-1}"#).is_err());
    // what the browser reads back is what it sends back
    let again: Config = serde_json::from_value(out).unwrap();
    assert_eq!(again.seed, from_number.seed);
}

#[test]
fn noise_keys_with_a_big_seed_match_the_browser() {
    // The browser builds "<seed>:<seat>:<instrument>:<node>" from the seed text; the values are checked against client/js/prng.js.
    use band_game::prng::Mulberry32;
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/prng_big_seed.json")).unwrap();
    let cases: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    assert!(cases.len() >= 4);
    for c in cases {
        let mut rng = Mulberry32::from_key(c["key"].as_str().unwrap());
        for want in c["values"].as_array().unwrap() {
            let got = rng.next_bipolar();
            assert!((got - want.as_f64().unwrap()).abs() < 1e-12, "{}: {got} vs {want}", c["key"]);
        }
    }
}
