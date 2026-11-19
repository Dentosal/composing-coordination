//! The canonical renderer, shared by the server and the browser's WebAssembly build (renderer/wasm).
//! It must build for wasm32-unknown-unknown: no threads, clocks, files or audio devices.

pub mod orders;
pub mod prng;
pub mod render;
