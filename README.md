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
and the browser runs the same code compiled to WebAssembly (`client/wasm/renderer.wasm`): for the editor's playback
(`client/js/stream.js`: rendered live in a worker a little ahead of playback, while an AudioWorklet plays it, so the
audio thread never synthesizes anything) and for the download menu's "rendered in this browser". Live playback needs
SharedArrayBuffer, so the server sends the cross-origin isolation headers (COOP/COEP); a server in front of it must
keep them, else the editor falls back to the browser's own voices (`client/js/live.js`). `stream-test.html` checks
that playback keeps up. The renderer uses a fork of the `web-audio-api` crate in `vendor/` (see its FORK.md). After changing anything in `renderer/`, run `tools/build-wasm.sh` (needs
`rustup target add wasm32-unknown-unknown`; uses `wasm-opt` when installed) and commit the rebuilt module:
`node --test client/js/*.test.mjs` fails while it is out of date.

## Orders format
Defined in `renderer/src/orders.rs` (mirrored as JSDoc in `client/js/types.js`).
Presets in `client/presets/*.json` are `{label, instrument}` where `instrument` is an orders instrument.
