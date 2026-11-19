//! The sound budget: how many different sounds each player may use over a whole game.

use band_game::orders::Orders;
use band_game::state::{part_sounds, Config, RoundState, Session, Shared, TimeoutPolicy};

/// An instrument `id` whose sound is a sine at `level`, and a lane for it with a note (or none).
fn part(tracks: &[(&str, f32, bool)]) -> Orders {
    let insts: Vec<String> = tracks.iter().map(|(id, level, _)| format!(
        r#"{{"id":"{id}","name":"Name {id}","nodes":[{{"id":"o","type":"osc","wave":"sine"}},{{"id":"g","type":"gain","gain":{level}}},{{"id":"out","type":"out"}}],
           "edges":[{{"from":"o","to":"g"}},{{"from":"g","to":"out"}}]}}"#)).collect();
    let lanes: Vec<String> = tracks.iter().map(|(id, _, note)| format!(
        r#"{{"instrument":"{id}","steps":[{}]}}"#, if *note { r#"{"row":0,"note":60}"# } else { "" })).collect();
    serde_json::from_str(&format!(r#"{{"instruments":[{}],"lanes":[{}]}}"#, insts.join(","), lanes.join(","))).unwrap()
}

#[test]
fn a_sound_is_the_instrument_without_its_name_and_only_tracks_with_notes_count() {
    let p = part(&[("a", 0.5, true), ("b", 0.5, true), ("c", 0.7, true), ("d", 0.9, false)]);
    let s = part_sounds(&p);
    assert_eq!(s.len(), 3, "the silent track does not count");
    assert_eq!(s[0].0, s[1].0, "a and b are the same sound under different names");
    assert_eq!((s[0].1, s[1].1), (0, 1), "but two tracks of it need two tracks");
    assert_ne!(s[0].0, s[2].0);
}

fn game(cfg: &str) -> (Session, Shared) {
    let mut s = Session::new(serde_json::from_str::<Config>(cfg).unwrap());
    s.join_as(Some("Ada")).unwrap();
    let sh: Shared = Default::default();
    s.start(&sh).unwrap();
    (s, sh)
}

/// Play round `n` with these orders: mark it resolved as the server does.
fn play(s: &mut Session, o: Orders) {
    s.put_orders(0, o).unwrap().unwrap();
    let r = s.rounds.last_mut().unwrap();
    let id = s.seats[0].id;
    r.played = vec![(0, r.orders[&id].clone())];
    r.state = RoundState::Resolved;
    let n = r.index;
    s.rounds.push(band_game::state::Round { index: n + 1, ..empty_round() });
}

fn empty_round() -> band_game::state::Round {
    band_game::state::Round {
        index: 0, state: RoundState::Open, deadline: None, deadline_ms: None, orders: Default::default(),
        ready: Default::default(), mix: None, played: Vec::new(),
    }
}

#[test]
fn reusing_sounds_is_free_and_the_budget_is_checked_on_ready() {
    let (mut s, _sh) = game(r#"{"max_lanes":2,"max_instruments":2,"max_sounds":3}"#);
    assert_eq!(s.config.sound_budget(), 3);
    play(&mut s, part(&[("a", 0.1, true), ("b", 0.2, true)]));
    // Round 2: one new sound and one old one, under different ids: 3 of 3.
    s.put_orders(0, part(&[("x", 0.1, true), ("y", 0.3, true)])).unwrap().unwrap();
    assert_eq!(s.sounds_json(0)["used"], 3);
    assert!(s.set_ready(0, true).is_ok());
    // Trying sounds in the draft costs nothing until it is played: a different new one is still three.
    s.put_orders(0, part(&[("x", 0.1, true), ("y", 0.4, true)])).unwrap().unwrap();
    assert_eq!(s.sounds_json(0)["used"], 3);
    // Two new ones would be four.
    s.put_orders(0, part(&[("x", 0.5, true), ("y", 0.4, true)])).unwrap().unwrap();
    assert_eq!(s.sounds_json(0)["used"], 4);
    assert!(s.set_ready(0, true).is_err(), "over the budget");
    // Going back to an earlier sound is free.
    s.put_orders(0, part(&[("x", 0.2, true), ("y", 0.1, true)])).unwrap().unwrap();
    assert!(s.set_ready(0, true).is_ok());
}

#[test]
fn the_budget_bounds_the_players_and_must_cover_the_tracks() {
    let cfg = |j: &str| serde_json::from_str::<Config>(j).unwrap();
    assert_eq!(Config::default().sound_budget(), 8, "twice the tracks by default");
    assert_eq!(Config::default().max_players(), 8);
    assert!(cfg(r#"{"max_lanes":8,"max_instruments":8,"max_sounds":4}"#).validate().is_err(), "fewer sounds than tracks");
    assert!(cfg(r#"{"max_sounds":65}"#).validate().is_err());
    assert!(cfg(r#"{"max_lanes":8,"max_instruments":8,"max_sounds":16}"#).validate().is_ok());
    let mut s = Session::new(cfg(r#"{"max_lanes":8,"max_instruments":8,"max_sounds":16}"#));
    for _ in 0..4 {
        s.join().unwrap();
    }
    assert!(s.join().is_err(), "a fifth player's sounds would not fit in 64 tracks");
}

#[test]
fn a_draft_over_the_budget_played_on_timeout_gives_way_to_the_last_part() {
    let (mut s, _sh) = game(r#"{"max_lanes":1,"max_instruments":1,"max_sounds":1,"timeout_policy":"RepeatLast"}"#);
    assert_eq!(s.config.timeout_policy, TimeoutPolicy::RepeatLast);
    play(&mut s, part(&[("a", 0.1, true)]));
    s.put_orders(0, part(&[("a", 0.5, true)])).unwrap().unwrap(); // a second sound: over
    assert_eq!(s.sounds_used(0, 2, s.rounds.last().unwrap().orders.values().next()), 2);
    let played = s.orders_to_play(0, 2);
    assert_eq!(part_sounds(&played), part_sounds(&part(&[("a", 0.1, true)])), "the last part plays instead");
}

#[test]
fn a_game_is_at_most_256_bars() {
    let cfg = |j: &str| serde_json::from_str::<Config>(j).unwrap();
    assert_eq!(cfg(r#"{"bars":4}"#).max_rounds(), 64);
    assert!(cfg(r#"{"bars":4,"rounds":64}"#).validate().is_ok());
    assert!(cfg(r#"{"bars":4,"rounds":65}"#).validate().is_err());
    assert!(cfg(r#"{"bars":16,"rounds":17}"#).validate().is_err());
}
