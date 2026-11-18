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
