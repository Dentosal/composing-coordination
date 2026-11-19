# Band Game — MVP Design

A browser game where a small group of humans write parts for one shared loop without talking to each other. Each round, everyone edits their own instruments and patterns, commits, and then hears only the resulting band mix. Inspired by the Band-it-is'm experiment (five Claude instances writing one song through a synth tracker), rebuilt for human players with a visual graph editor.

Purely for fun. Not competitive, not a research tool.

## Game rules (MVP)

- A session has any number of seats (public count; no cap). The host starts the game whenever they want, and players may keep joining afterwards. Seats are anonymous: nobody is shown which part belongs to whom.
- A round is a fixed loop (default: 4 bars of 4/4 at 112 BPM, 16 rows per bar = 64 rows, ~8.6 s).
- **Commit and reveal.** During a round, each player edits their orders (instruments + patterns) against the *previous* round's mix. When the round resolves, the server renders the new mix and everyone hears it at once.
- **No stems.** Players receive only the full mix. They can render their own part locally, but the client offers no tool for isolating others (no subtraction, no solo of others).
- A round resolves when every seated player is ready, or when the round timer expires (if configured).
- Players who haven't committed when a round resolves: per `timeout_policy`, either the round waits (`Wait`) or their previous orders repeat (`RepeatLast`). A player with no previous orders is silent.
- Players may join after the session starts. They hear the latest mix and start contributing in the next open round.
- The session ends after a configured number of rounds, or when the host ends it. The end screen offers playback and download of the full song (all rounds back to back).

## Stack

- **Server:** Rust, axum, tokio, serde, `web-audio-api` crate for canonical offline renders. In-memory state only; a session nobody has open (no event stream) and nobody has used for an hour is removed, so at most 200 live sessions are kept. Serves the client as static files (tower-http `ServeDir`). One binary.
- **Client:** vanilla JS (ES modules, no build step), a fixed-architecture synth patch editor (`client/js/synth.js`, 3 oscillators + noise, filter, drive, amp/filter/pitch envelopes, LFO) that reads and writes ordinary orders graphs; playback rendered by the server's own renderer, compiled to WebAssembly and running in the browser (`client/js/stream.js`). **No Tone.js.**
- **Shared contract:** the orders format, defined by the existing Rust serde structs. These are the source of truth. Do not redesign them; the JS side mirrors them (JSDoc types are enough).

## Repository layout

```
server/
  Cargo.toml
  src/
    main.rs          # axum setup, routes, static files
    api.rs           # handlers
    state.rs         # sessions, seats, rounds, state machine
    orders.rs        # existing serde structs + semantic validation
    render/          # orders -> Web Audio graph -> WAV
    prng.rs          # seeded PRNG (must match client/js/prng.js)
  src/bin/render.rs  # CLI: render orders JSON -> WAV (for parity tests)
client/
  index.html
  js/ main.js api.js editor.js pattern.js render.js prng.js audio.js
  presets/           # JSON instrument presets
fixtures/            # golden patches for parity tests
tests/parity/        # browser-vs-Rust render comparison
```

## Session config

All configurable at session creation; defaults in brackets.

| Field | Meaning |
|---|---|
| `bpm`, `bars` | loop shape [112, 4]; `rows_per_bar` is fixed at 16 (accepted only as 16, still reported) |
| `max_lanes`, `max_instruments` | per-player limits [4, 4]; one track = one instrument + one lane, so the lobby sets both from one "tracks" field |
| `max_sounds` | `Option<u32>`: different sounds (instruments as set up, names aside) each player may play over the whole game, None = 2 × tracks. Checked on ready; reusing a sound is free, effects cost nothing, a track without notes does not count. The state's `you.sound_list` has the sounds a player has played in the song (each once, as last played, with its rounds); the header's sounds counter lists them on hover, to preview and load into a track (an exact copy, so free). It sizes the game's combined scene (one track per player and sound), so players × sounds ≤ 64 and joins past that are refused [None] |
| `attempts` | attempts at each round [2; the first round gets one more, as it is written blind]. After every attempt but the last, the players of the round vote in secret on keeping it (`POST /vote {keep}`, changeable until the last vote is in; only counts are told). All yes keeps it; otherwise the round is played again: an attempt voted down is not in the song, its sounds are free again, the band is the round before it, and each player's draft starts from their rejected part. The last attempt is kept without a vote |
| `rounds` | `Option<u32>`, None = until host ends [None]. A game is at most 256 bars (so its combined scene opens in the freeform editor): rounds ≤ 256 / bars, and an open-ended game ends there |
| `round_timer_secs` | `Option<u32>`, None = no timer [None] |
| `timeout_policy` | `Wait` \| `RepeatLast` [Wait] |
| `seed` | u64 for deterministic renders [random] |

## Server

### State

`Arc<RwLock<AppState>>` holding `HashMap<SessionId, Session>`. A session holds its config, host token, seats, rounds and an SSE broadcast channel (`tokio::sync::broadcast`).

- `Seat { token: Uuid, kind: Human | Bot, joined_round: u32 }`. The token is a random UUID and the only credential. `Bot` is reserved for later AI seats; they will use the same HTTP API.
- `Round { index, state: Open | Rendering | Resolved, deadline: Option<Instant>, orders: HashMap<SeatId, Orders>, ready: HashSet<SeatId>, mix: Option<Arc<[u8]>> /* WAV */ }`

### Round lifecycle

`Lobby → Open(n) → Rendering(n) → Resolved(n) → Open(n+1) → … → Ended`

- **Open:** seats `PUT` orders (validated, replaceable until resolve) and toggle ready. Resolve when all seated players are ready, or when the deadline passes (a tokio timer task).
- **Rendering:** fill in missing orders per `timeout_policy`, render on a blocking thread (`spawn_blocking`), store the WAV.
- **Resolved:** broadcast `round_resolved`, then immediately open the next round (or end the session).

With `Wait` and no timer, a round stays open until everyone is ready. That is the intended async mode.

### HTTP API

Auth: `X-Session-Token: <token>` (seat token or host token). `Authorization: Bearer <token>` and `?token=` work too;
the client uses its own header so that `Authorization` stays free for a login in front of the server (basic auth in nginx).

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/sessions` | anyone | create; body = config; returns `{session_id, host_token}` |
| `POST /api/sessions/:id/join` | anyone | take a free seat; body `{name}` (the nickname; optional, "Player N" without); returns `{seat_token}` |
| `PUT /api/sessions/:id/name` | seat | body `{name}`: change the nickname (1-24 characters, whitespace tidied) |
| `POST /api/sessions/:id/start` | host | Lobby → Open(1) |
| `POST /api/sessions/:id/end` | host | end after the current round resolves |
| `POST /api/sessions/:id/players/:seat/kick` | host | remove a player (`seat` = join-order index from the player list): their token stops working, their draft for the open round is dropped, the round resolves if everyone left is ready. The seat keeps its index, and its earlier rounds stay in the song |
| `POST /api/sessions/:id/players/:seat/admit` | host | a player waiting for the next round plays in the open round instead |
| `GET /api/sessions/:id/state` | seat | config, round index/state, deadline, seat count, ready count, players, own name and latest orders |
| `PUT /api/sessions/:id/orders` | seat | submit orders for the open round; returns validation errors or OK |
| `POST /api/sessions/:id/ready` | seat | body `{ready: bool}` |
| `GET /api/sessions/:id/rounds/:n/mix.wav` | seat | only for resolved rounds |
| `GET /api/sessions/:id/song.wav` | seat | after end; all rounds rendered in one pass |
| `GET /api/sessions/:id/song-parts` | seat | every resolved round's parts and the players' names: the browser lays them end to end (`client/js/combine.js`) to play the song so far after each round and to build the combined scene file |
| `GET /api/sessions/:id/events` | seat | SSE stream |

The seat token can also be passed as a `?token=` query parameter on `events` and `.wav` routes, because `EventSource` and `<audio>` can't set headers.

SSE events (JSON payloads): `seat_count`, `ready_count`, `players {players: [{seat, name, ready, eligible, online}]}`, `round_opened {n, deadline}`, `round_resolved {n}`, `votes {n, cast, total}`, `vote_result {n, kept}`, `session_ended`. Players are listed by nickname with their ready state in the current round, and `online` false once their page has had no event stream for 5 s (a reload stays within that); nothing says what anyone wrote, though `seat` (the join order) is also on each part from `rounds/:n/parts`.

### Validation

serde handles shape. Semantic checks: limits from config, every referenced node/instrument exists, params in range, no cycles in instrument graphs, notes within the loop. Return errors as a list of `{path, message}` the client can display.

## Rendering

The same JSON must produce (nearly) the same audio in the browser and on the server. Rules:

1. **Map orders 1:1 onto Web Audio primitives** (`OscillatorNode`, `BiquadFilterNode`, `GainNode`, `DelayNode`, `WaveShaperNode`, `ConvolverNode`, `AudioBufferSourceNode`). The JS renderer (`client/js/render.js`) and the Rust renderer (`renderer/src/render/`) are line-by-line ports of each other. Keep them structurally parallel.
2. **No Transport.** Precompute every note's start time from row index, BPM and rows per bar, and schedule everything up front in an `OfflineAudioContext`.
3. **Voices:** instantiate the instrument graph once per note, schedule start/stop, let it be collected afterwards.
4. **Envelopes:** ADSR via AudioParam automation (`setValueAtTime`, `linearRampToValueAtTime`, `setTargetAtTime`). Implement identically on both sides.
5. **Noise and anything random:** generated into `AudioBuffer`s from a seeded PRNG (mulberry32 or xorshift32, implemented identically in `prng.rs` and `prng.js`), seeded from `(session seed, seat index, instrument id, node id)`.
6. **Master chain:** per-seat gain → shared send to delay + reverb (convolver with an IR generated from the seeded PRNG) → limiter (a `WaveShaperNode` with a static curve: -6 dB threshold, ratio 20, makeup gain; no look-ahead, so no delay) → output. No per-player loudness rule in the MVP.
7. **Seamless loops:** render each round as two consecutive loops and keep the second, so reverb and delay tails wrap into the loop start.
8. **Output:** 48 kHz stereo, 16-bit WAV.

The full song is rendered as one continuous pass over all rounds, so tails carry across round boundaries.

### Parity tests

- `fixtures/` holds golden orders files covering every node type and the envelope edge cases.
- The Rust CLI (`src/bin/render.rs`) renders each fixture to WAV.
- A browser test page renders the same fixtures with `OfflineAudioContext`, driven headlessly (Playwright) in the test script.
- Pass if the RMS of the difference is at least 50 dB below the RMS of the signal. Tune the threshold once real numbers come in. Add a fixture whenever a node type is added.

## Client

Single page. Seat token stored in `localStorage` per session, and also kept in the URL so the same seat can be reopened on another device.

### Screens

- **Lobby:** create session (config form) or join via link; everyone, the host included, picks a nickname (remembered in the browser, editable from the lobby and the top bar). The lobby lists the players; the host sees a start button.
- **Game:**
  - **Top bar:** round number, countdown (if timed), `ready k / n` (hover: who is ready, who is writing, who joins next round; the host can kick a player there, with a confirmation unless they have disconnected, or let a waiting one join now), seat count, own nickname.
  - **Playback:** loops the latest resolved round's band, rendered in the browser from the parts its players committed (`GET /rounds/{n}/parts`), by the server's renderer compiled to WebAssembly and streamed from a worker (`client/js/stream.js`). Toggle "preview my part": the player's current orders play in place of their committed part, edits heard about 100 ms later. Without cross-origin isolation the client falls back to the server's rendered mix with a live preview from the browser's own voices.
  - **Instrument editor:** a tab per instrument and a fixed-template synth editor. The template (`client/js/synth.js`) is a canonical node graph with fixed node ids; edits change parameters and routing, and the graph is rebuilt from the patch. Instruments that don't match the template exactly are shown as "custom" (output levels only). Presets (`client/presets/`, generated by `tools/gen-presets.mjs`) are template instruments used as starting points.
  - **Pattern editor:** tracker-style grid, one column per track, `bars × rows_per_bar` rows. Keyboard note entry (piano-row keys, octave up/down), note-off, velocity. A track is one instrument and its own lane (one-to-one; the server rejects shared or missing lanes).
  - **Commit/ready button:** `PUT`s the orders, shows validation errors inline, then marks ready. Editing after ready un-readies.
- **After each round:** a dialog plays the song so far, rendered in the browser by the streaming player from `song-parts`. At the end of the game it offers `song.wav` and the combined scene file: every player's tracks over the whole game (one track per player and sound), which opens in the freeform editor.
- **End:** play and download `song.wav` and the combined scene file.

Audio unlock: create/resume the `AudioContext` on the join or start click.

### Presets (MVP set)

bass, pad, lead, pluck, kick, snare, hat. They must be built only from the orders' node types, since they are plain orders JSON.

## Milestones

1. Rust renderer + CLI: orders JSON → WAV, all node types, master chain.
2. JS renderer + parity tests passing on all fixtures.
3. Server: sessions, seats, round state machine, timers, SSE, WAV endpoints.
4. Client: lobby, mix player, pattern editor, preset picker (no graph editing yet). **First playable.**
5. Fixed-template synth patch editor + preview over the previous mix. (A free node-graph editor, e.g. LiteGraph, remains possible later.)
6. End screen with full-song render.

## Out of scope for the MVP (keep the design open to them)

- AI seats (`Seat::Bot`, playing through the same API with a seat token).
- Constraint cards (private and public).
- Loudness/level rule.
- The rich end-of-game reveal (stems, timeline replay, "which seat was whose" vote).
- Persistence across restarts.
- Compressed audio delivery (Opus).
- Hybrid timeout (soft timeout + vote to repeat an absent player).