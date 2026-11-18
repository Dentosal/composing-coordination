//! The "unlimited tracks" session option raises the per-player track limits to a fixed ceiling.

use band_game::state::{Config, UNLIMITED_TRACK_CAP};

#[test]
fn unlimited_tracks_lifts_the_limits_to_the_ceiling() {
    let normal: Config = serde_json::from_str(r#"{"max_lanes":3,"max_instruments":3}"#).unwrap();
    assert!(!normal.unlimited_tracks);
    assert_eq!((normal.limits().max_lanes, normal.limits().max_instruments), (3, 3));

    let open: Config = serde_json::from_str(r#"{"max_lanes":3,"max_instruments":3,"unlimited_tracks":true}"#).unwrap();
    assert!(open.validate().is_ok());
    assert_eq!((open.limits().max_lanes, open.limits().max_instruments), (UNLIMITED_TRACK_CAP, UNLIMITED_TRACK_CAP));
    assert!(UNLIMITED_TRACK_CAP > 16, "more than the 16 a normal session can start with");
}
