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
