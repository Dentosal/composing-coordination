//! Voting on a round: kept only when everyone says yes, else played again, up to the attempts allowed.

use band_game::state::{Config, Phase, RoundState, Session, Shared};
use std::sync::Arc;

fn game(cfg: &str, players: usize) -> (Session, Shared) {
    let mut s = Session::new(serde_json::from_str::<Config>(cfg).unwrap());
    for i in 0..players {
        s.join_as(Some(&format!("P{i}"))).unwrap();
    }
    let sh: Shared = Default::default();
    s.start(&sh).unwrap();
    (s, sh)
}

/// The open round is played (its mix rendered): what the server does once everyone is ready.
fn play(s: &mut Session, sh: &Shared) -> u32 {
    let r = s.rounds.last_mut().unwrap();
    r.state = RoundState::Rendering;
    let n = r.index;
    s.finish_resolve(n, Arc::from(vec![0u8; 4]), sh);
    n
}

fn last(s: &Session) -> (u32, u32, u32, RoundState) {
    let r = s.rounds.last().unwrap();
    (r.index, r.slot, r.attempt, r.state)
}

#[tokio::test]
async fn one_no_plays_the_round_again_and_all_yes_keeps_it() {
    let (mut s, sh) = game(r#"{"rounds":3}"#, 2);
    assert_eq!(s.config.attempts, 2, "default: one repeat");
    assert_eq!(s.config.attempts_at(1), 3, "the first round has one more");
    play(&mut s, &sh);
    assert_eq!(s.vote_count(), Some((0, 2)), "round 1, attempt 1 of 3: a vote");
    s.vote(0, true, &sh).unwrap();
    s.vote(0, false, &sh).unwrap(); // changed their mind: still one vote
    assert_eq!(s.vote_count(), Some((1, 2)));
    s.vote(1, true, &sh).unwrap();
    // Not unanimous: round 1 again.
    assert!(s.rounds[0].rejected);
    assert_eq!(last(&s), (2, 1, 2, RoundState::Open));
    assert!(s.vote(0, true, &sh).is_err(), "nothing to vote on while writing");

    play(&mut s, &sh);
    s.vote(0, true, &sh).unwrap();
    s.vote(1, true, &sh).unwrap();
    assert!(!s.rounds[1].rejected, "everyone said yes");
    assert_eq!(last(&s), (3, 2, 1, RoundState::Open), "on to round 2 of the song");

    // Round 2 has two attempts: voted down once, the second attempt is kept without a vote.
    play(&mut s, &sh);
    s.vote(0, false, &sh).unwrap();
    s.vote(1, true, &sh).unwrap();
    assert_eq!(last(&s), (4, 2, 2, RoundState::Open));
    play(&mut s, &sh);
    assert_eq!(s.vote_count(), None, "the last attempt is kept as it is");
    assert_eq!(last(&s), (5, 3, 1, RoundState::Open));

    // The song is the kept rounds only.
    let song: Vec<u32> = s.rounds.iter().filter(|r| r.in_song()).map(|r| r.index).collect();
    assert_eq!(song, [2, 4]);
}

#[tokio::test]
async fn the_game_ends_when_its_last_round_is_kept() {
    let (mut s, sh) = game(r#"{"rounds":1,"attempts":1}"#, 1);
    play(&mut s, &sh);
    assert_eq!(s.vote_count(), Some((0, 1)), "round 1 has one more attempt even with attempts = 1");
    s.vote(0, true, &sh).unwrap();
    assert_eq!(s.phase, Phase::Ended);
}

#[tokio::test]
async fn a_kicked_player_does_not_hold_up_the_vote() {
    let (mut s, sh) = game(r#"{"rounds":3}"#, 2);
    play(&mut s, &sh);
    s.vote(0, true, &sh).unwrap();
    s.kick(1, &sh).unwrap();
    assert_eq!(last(&s), (2, 2, 1, RoundState::Open), "everyone left said yes");
}

#[test]
fn attempts_are_checked() {
    let cfg = |j: &str| serde_json::from_str::<Config>(j).unwrap();
    assert!(cfg(r#"{"attempts":0}"#).validate().is_err());
    assert!(cfg(r#"{"attempts":11}"#).validate().is_err());
    assert!(cfg(r#"{"attempts":1}"#).validate().is_ok());
}
