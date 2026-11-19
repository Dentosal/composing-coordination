# Band Game

See `designdoc.md`. Status: milestones 1 (Rust renderer + CLI), 3 (server) and 4 (first playable client).

## Run
    cd server && cargo run --release        # http://localhost:3000, serves ../client
    PORT=3055 CLIENT_DIR=../client cargo run --release

## Tools
    cargo run --release --bin render -- fixtures/band.json out.wav   # orders JSON -> WAV
    cargo test                                                       # unit tests
    CHROME_PATH=/path/to/chrome deno run -A tests/e2e/smoke.ts http://localhost:3000   # two-browser playthrough
    tools/build-wasm.sh                                              # renderer -> client/wasm/renderer.wasm

## Renderer
The renderer (`renderer/`, crate `band-render`) is shared: the server uses it for round mixes, previews and song files,
and the browser runs the same code compiled to WebAssembly (`client/wasm/renderer.wasm`, used by the download menu's
"rendered in this browser"). After changing anything in `renderer/`, run `tools/build-wasm.sh` (needs
`rustup target add wasm32-unknown-unknown`; uses `wasm-opt` when installed) and commit the rebuilt module:
`node --test client/js/*.test.mjs` fails while it is out of date.

## Orders format
Defined in `renderer/src/orders.rs` (mirrored as JSDoc in `client/js/types.js`).
Presets in `client/presets/*.json` are `{label, instrument}` where `instrument` is an orders instrument.
