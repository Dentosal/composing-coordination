//! The renderer as a WebAssembly module for the browser (see client/js/render-worker.js), with a plain C-style
//! interface: no generated glue, just numbers and pointers into the module's memory.
//!
//! Imports (module "env"):
//!   progress(fraction: f64)            rendering has reached `fraction` (every few seconds of audio)
//!   report_error(ptr: u32, len: u32)   a UTF-8 message about why the render failed (called before a panic aborts it)
//! Exports:
//!   alloc(len) -> ptr, dealloc(ptr, len)    memory for passing bytes in and out
//!   render_song(orders_ptr, orders_len, bpm, bars, rows_per_bar, seed, seat_index) -> ptr
//!       Renders the orders (JSON) as a song file (see band_render::render::render_song) and returns a pointer to
//!       [u32 length, little-endian][that many bytes of WAV], or 0 on an error (after report_error). The caller frees
//!       the result with dealloc(ptr, 4 + length).

use band_render::orders::Orders;
use band_render::render::{render_song_with_progress, wav, RenderConfig, SeatPart};

extern "C" {
    fn progress(fraction: f64);
    fn report_error(ptr: *const u8, len: usize);
}

fn report(msg: &str) {
    unsafe { report_error(msg.as_ptr(), msg.len()) }
}

fn on_progress(fraction: f64) {
    unsafe { progress(fraction) }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `alloc(len)` (or be a result of `render_song`, with `len` its full size).
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// # Safety
/// `orders_ptr` must point to `orders_len` bytes from `alloc`; they are taken over (freed) by this call.
#[no_mangle]
pub unsafe extern "C" fn render_song(
    orders_ptr: *mut u8,
    orders_len: usize,
    bpm: f32,
    bars: u32,
    rows_per_bar: u32,
    seed: u64,
    seat_index: u32,
) -> *mut u8 {
    std::panic::set_hook(Box::new(|info| report(&info.to_string())));
    let bytes = Vec::from_raw_parts(orders_ptr, orders_len, orders_len);
    let orders: Orders = match serde_json::from_slice(&bytes) {
        Ok(o) => o,
        Err(e) => {
            report(&format!("the song could not be read: {e}"));
            return std::ptr::null_mut();
        }
    };
    let cfg = RenderConfig { bpm, bars, rows_per_bar, seed };
    let stereo = render_song_with_progress(&cfg, &[vec![SeatPart { seat_index, orders: &orders }]], Some(on_progress));
    let wav = wav::encode(&stereo);
    let mut out = Vec::with_capacity(4 + wav.len());
    out.extend_from_slice(&(wav.len() as u32).to_le_bytes());
    out.extend_from_slice(&wav);
    let mut out = std::mem::ManuallyDrop::new(out.into_boxed_slice());
    out.as_mut_ptr()
}
