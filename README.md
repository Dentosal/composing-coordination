# Band Game

See `designdoc.md`. Status: milestones 1 (Rust renderer + CLI), 3 (server) and 4 (first playable client).

## Run
    cd server && cargo run --release        # http://localhost:3000, serves ../client
    PORT=3055 CLIENT_DIR=../client cargo run --release

## Tools
    cargo run --release --bin render -- fixtures/band.json out.wav   # orders JSON -> WAV
    cargo test                                                       # unit tests
    CHROME_PATH=/path/to/chrome deno run -A tests/e2e/smoke.ts http://localhost:3000   # two-browser playthrough

## Orders format
Defined in `server/src/orders.rs` (mirrored as JSDoc in `client/js/types.js`).
Presets in `client/presets/*.json` are `{label, instrument}` where `instrument` is an orders instrument.
