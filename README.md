# Band Game

A browser game where a group of people write a song together without talking to each other.

Each round, every player writes their own part of a short loop: their instruments (built on a small synthesizer) and
the notes and effects they play. Nobody sees what the others are doing. When everyone is ready, the parts are mixed
into one band loop, and everyone hears the result at the same time. The next round is written on top of that loop,
and round by round, the loops add up to a song.

The idea comes from an experiment in which several AI models wrote one song together through a synth tracker; this is
the same setup for human players. It's for fun: there is no score and no winner.

## How a game goes

1. **Create a session** on the start page, choose a nickname and share the link. The others join with their own
   nicknames; the host starts the game when everyone is in. Players can join later too: they start in the next round.
2. **Write your part.** Every player has a few tracks; each track is one instrument and its notes. The footer plays
   your draft over the last round's band, your draft alone, or the last round as it was played. Press **Ready** when
   you're done (**Unready** takes it back).
3. **Listen and vote.** When everyone is ready, the round is rendered, and a dialog plays the song so far. Everyone who
   played votes, in secret, on keeping the round. It takes every vote: otherwise the round is played again, up to a
   set number of attempts (the last attempt is kept as it is).
4. **Repeat** until the last round. Then download the song as audio, or as a scene file with every player's tracks
   over the whole game, which opens in the freeform editor.

Sounds are limited: each player can use a set number of different sounds over the whole game (reusing one costs
nothing, and effects are free). Hover the sounds counter in the header to load a sound you played earlier.

The host can set the tempo, loop length, tracks and sounds per player, number of rounds, attempts per round and a
round timer. The host can also remove players, or let a late joiner into the current round.

## Freeform editor

The same editor without the game: one person, as many tracks as you like, a song of up to 256 bars, and a tempo you
can change as you go. Open it empty from the start page, drop a scene file on it, or open one of the demo songs.
The download menu saves the song as audio (rendered on the server or in the browser) or as a scene file.

## Running it

You need a Rust toolchain.

    cd server
    cargo run --release                        # serves the game at http://localhost:3000
    PORT=3055 CLIENT_DIR=../client cargo run --release

The server keeps everything in memory: sessions disappear when it restarts, and a session that nobody has had open
for an hour is removed.

If you put another server in front of it, keep the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
headers it sends. The browser needs them for the streaming player (see below). Without them, playback falls back to
the browser's own audio engine, which can crackle with bigger songs.

## How it works

- **Server** (`server/`): Rust with axum and tokio. Sessions, seats, rounds and votes; the round mixes and the
  finished song are rendered here. Clients get live updates through server-sent events.
- **Renderer** (`renderer/`, crate `band-render`): turns orders (instruments, notes, effects) into audio with a fork
  of the `web-audio-api` crate (`vendor/web-audio-api`, see its `FORK.md`). The same code is compiled to WebAssembly
  (`client/wasm/renderer.wasm`) and runs in the browser, so what you hear while editing is what the server renders.
- **Client** (`client/`): plain JavaScript modules, no build step and no frameworks. The editor's playback renders in
  a Web Worker a little ahead of time and plays through an AudioWorklet (`client/js/stream.js`); that is what needs the
  cross-origin isolation headers.
- **Orders format**: defined in `renderer/src/orders.rs` and mirrored as JSDoc in `client/js/types.js`. Presets
  (`client/presets/`) and scene files (`client/js/scene.js`) are built on it.

`designdoc.md` has the details: the game rules, the API, the audio pipeline and the decisions behind them.

## Development

    cd server && cargo test                    # server and renderer tests
    node --test client/js/*.test.mjs           # client tests
    tools/build-wasm.sh                        # rebuild client/wasm/renderer.wasm after changing renderer/

After any change to `renderer/` or `vendor/web-audio-api/`, rebuild the WebAssembly module and commit it with the
change: the client tests fail while it is out of date. Building it needs
`rustup target add wasm32-unknown-unknown`, and uses `wasm-opt` when it is installed.

Other tools:

    cd server && cargo run --release --bin render -- ../fixtures/band.json out.wav   # orders JSON -> WAV
    node tools/gen-presets.mjs                 # regenerate client/presets/
    python3 tools/gen-song-low-orbit.py        # regenerate a demo song (also gen-song-night-relay.py, gen-song.py)
    tools/parity/run.sh                        # compare the browser's voices with the server renderer (needs Chrome)

`client/stream-test.html` is a check page for the streaming player: it loops a demo song and shows whether playback
keeps up.
