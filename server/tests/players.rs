//! Nicknames and the player list.

use band_game::state::{clean_name, Config, Session};

#[test]
fn nicknames_are_tidied_and_checked() {
    assert_eq!(clean_name("  Ada \t  Lovelace ").unwrap(), "Ada Lovelace");
    assert_eq!(clean_name("Åsa 🎸").unwrap(), "Åsa 🎸");
    assert!(clean_name("   ").is_err(), "empty");
    assert!(clean_name(&"x".repeat(25)).is_err(), "too long");
    assert!(clean_name(&"ö".repeat(24)).is_ok(), "the limit counts characters, not bytes");
    assert!(clean_name("a\u{7}b").is_err(), "control character");
}

#[test]
fn the_player_list_has_names_in_join_order() {
    let mut s = Session::new(Config::default());
    s.join_as(Some("Ada")).unwrap();
    s.join().unwrap();
    assert!(s.join_as(Some("")).is_err(), "a blank nickname is refused");
    let players = s.players();
    let names: Vec<_> = players.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, ["Ada", "Player 2"]);
    assert_eq!(players[1]["seat"], 1);
    assert_eq!(players[0]["ready"], false);
    assert_eq!(players[0]["eligible"], true);

    s.rename(1, " Grace ").unwrap();
    assert_eq!(s.players()[1]["name"], "Grace");
    assert!(s.rename(1, "").is_err());
    assert_eq!(s.players()[1]["name"], "Grace", "a refused rename keeps the old name");
}

#[test]
fn a_player_without_an_open_event_stream_shows_as_disconnected_after_the_grace_period() {
    use band_game::state::OFFLINE_GRACE;
    use std::time::Instant;
    let mut s = Session::new(Config::default());
    s.join_as(Some("Ada")).unwrap();
    let online = |s: &Session| s.players()[0]["online"].as_bool().unwrap();
    assert!(online(&s), "just joined: the page is still opening its stream");
    let mut never = Session::new(Config::default());
    never.join().unwrap();
    never.seats[0].left_at = Some(Instant::now() - OFFLINE_GRACE);
    assert_eq!(never.players()[0]["online"], false, "a seat whose page never connected goes offline too");
    s.connected(0);
    s.connected(0); // a second tab
    assert!(!s.disconnected(0), "one tab is still open");
    assert!(s.disconnected(0), "the last tab closed");
    assert!(online(&s), "within the grace period (a reload)");
    s.seats[0].left_at = Some(Instant::now() - OFFLINE_GRACE);
    assert!(!online(&s), "gone for longer than the grace period");
    s.connected(0);
    assert!(online(&s), "back");
}
