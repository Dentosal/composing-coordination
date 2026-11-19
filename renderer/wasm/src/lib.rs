//! The renderer as a WebAssembly module for the browser (see client/js/render-worker.js), with a plain C-style
//! interface: no generated glue, just numbers and pointers into the module's memory.
//!
//! Imports (module "env"):
//!   progress(fraction: f64)            rendering has reached `fraction` (every few seconds of audio)
//!   report_error(ptr: u32, len: u32)   a UTF-8 message about why the render failed (called before a panic aborts it)
//!   emit(left: u32, right: u32, frames: u32)   live_run only: the next block of audio, `frames` f32 samples of each
//!                                      channel at those addresses (valid only during the call). It may block, to keep
//!                                      the renderer just ahead of playback.
//!   cmd_len() -> u32                   live_run only: the size of the next command waiting (JSON), or 0
//!   cmd_read(ptr: u32)                 live_run only: copy that command to `ptr` and consume it
//! Exports:
//!   alloc(len) -> ptr, dealloc(ptr, len)    memory for passing bytes in and out
//!   render_song(orders_ptr, orders_len, bpm, bars, rows_per_bar, seed, seat_index) -> ptr
//!       Renders the orders (JSON) as a song file (see band_render::render::render_song) and returns a pointer to
//!       [u32 length, little-endian][that many bytes of WAV], or 0 on an error (after report_error). The caller frees
//!       the result with dealloc(ptr, 4 + length).
//!   live_run(bpm, bars, rows_per_bar, seed, start_row, loop_start, loop_end) -> ok
//!       Live playback (band_render::render::live): plays rows from start_row to loop_end, then loop_start..loop_end
//!       over and over, handing the audio to emit() as it renders, until a command says stop. The first command
//!       must carry the parts; later ones replace them (edits). Returns 1, or 0 on an error.

use band_render::orders::Orders;
use band_render::render::live::{self, Command, Transport};
use band_render::render::{render_song_with_progress, wav, RenderConfig, SeatPart};

extern "C" {
    fn progress(fraction: f64);
    fn report_error(ptr: *const u8, len: usize);
    fn emit(left: *const f32, right: *const f32, frames: usize);
    fn cmd_len() -> usize;
    fn cmd_read(ptr: *mut u8);
}

fn report(msg: &str) {
    unsafe { report_error(msg.as_ptr(), msg.len()) }
}

fn on_progress(fraction: f64) {
    unsafe { progress(fraction) }
}

/// The next command waiting, if any. One that cannot be read is reported and skipped.
fn next_command() -> Option<Command> {
    loop {
        let len = unsafe { cmd_len() };
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len];
        unsafe { cmd_read(buf.as_mut_ptr()) };
        match serde_json::from_slice(&buf) {
            Ok(c) => return Some(c),
            Err(e) => report(&format!("a command could not be read: {e}")),
        }
    }
}

/// The orders passed in (JSON at `ptr`, taken over), or None after reporting why they could not be read.
unsafe fn read_orders(ptr: *mut u8, len: usize) -> Option<Orders> {
    let bytes = Vec::from_raw_parts(ptr, len, len);
    match serde_json::from_slice(&bytes) {
        Ok(o) => Some(o),
        Err(e) => {
            report(&format!("the song could not be read: {e}"));
            None
        }
    }
}

/// Live playback until a command says stop (see the module documentation).
#[no_mangle]
pub extern "C" fn live_run(bpm: f32, bars: u32, rows_per_bar: u32, seed: u64, start_row: u32, loop_start: u32, loop_end: u32) -> u32 {
    std::panic::set_hook(Box::new(|info| report(&info.to_string())));
    let Some(first) = next_command() else {
        report("live_run needs the parts first");
        return 0;
    };
    if first.stop {
        return 1;
    }
    let cfg = RenderConfig { bpm, bars, rows_per_bar, seed };
    let transport = Transport { start: start_row, loop_start, loop_end };
    let mut sink = |l: &[f32], r: &[f32]| unsafe { emit(l.as_ptr(), r.as_ptr(), l.len().min(r.len())) };
    live::run(&cfg, transport, first.parts.unwrap_or_default(), &mut next_command, &mut sink);
    1
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
    let Some(orders) = read_orders(orders_ptr, orders_len) else { return std::ptr::null_mut() };
    let cfg = RenderConfig { bpm, bars, rows_per_bar, seed };
    let stereo = render_song_with_progress(&cfg, &[vec![SeatPart { seat_index, orders: &orders }]], Some(on_progress));
    let wav = wav::encode(&stereo);
    let mut out = Vec::with_capacity(4 + wav.len());
    out.extend_from_slice(&(wav.len() as u32).to_le_bytes());
    out.extend_from_slice(&wav);
    let mut out = std::mem::ManuallyDrop::new(out.into_boxed_slice());
    out.as_mut_ptr()
}
