//! Idle sessions are removed after an hour.

use band_game::state::{now_ms, Config, Session, IDLE_EXPIRY};
use std::sync::atomic::Ordering;

#[test]
fn a_session_expires_after_an_hour_with_nobody_connected_and_no_requests() {
    let s = Session::new(Config::default());
    let hour = IDLE_EXPIRY.as_millis() as u64;
    let now = now_ms();
    assert!(!s.expired(now), "just created");
    s.last_active.store(now - hour + 1000, Ordering::Relaxed);
    assert!(!s.expired(now), "idle for a little under an hour");
    s.last_active.store(now - hour, Ordering::Relaxed);
    assert!(s.expired(now), "idle for an hour");
    s.touch();
    assert!(!s.expired(now_ms()), "a request makes it new again");
}

#[test]
fn an_open_event_stream_keeps_a_session_alive() {
    let mut s = Session::new(Config::default());
    s.streams = 1;
    s.last_active.store(0, Ordering::Relaxed);
    assert!(!s.expired(now_ms()), "someone still has it open");
    s.streams = 0;
    assert!(s.expired(now_ms()));
}
