# web-audio-api 1.7.0, forked for band-game

The crate's source as published (1.7.0, MIT/Apache-2.0, see LICENSE), without its test resources except the one file
the source embeds (`resources/IRC_1003_C.bin`). Used through `[patch.crates-io]` in server/, renderer/ and renderer/wasm.

Changes, each marked `FORK (band-game)` in the source:

- src/lib.rs: no warnings about device code left unused when built without an audio backend (as here).

- `OfflineAudioContext::render_stream_sync` (src/context/offline.rs) and `RenderThread::render_stream_sync`
  (src/render/thread.rs): an offline render without end that hands each render quantum to a callback instead of
  storing it, and lets the callback create nodes between quanta. The browser's streaming player
  (renderer/src/render/live.rs) plays a song while it renders, for as long as it loops.

To update the crate: copy the new version's src/ and Cargo.toml here, then re-apply the changes above.
