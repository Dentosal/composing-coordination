// Shared memory between the streaming player (stream.js, main thread), its render worker (live-worker.js) and its
// audio-thread player (stream-processor.js). Two SharedArrayBuffers per run:
//
// The audio ring: an Int32 header, then the left channel, then the right, each CAPACITY float samples. WRITE and READ
// are frame counters that only grow (the position in the ring is the counter modulo the capacity): the worker owns
// WRITE, the audio thread owns READ. Neither ever waits on the audio thread.
//
// The mailbox: commands (JSON) from the main thread to the worker, which cannot take messages while it renders. One
// slot; a newer command replaces one not yet read (the latest parts are all that matter). STATE moves
// EMPTY -> WRITING -> FULL (main thread) and FULL -> READING -> EMPTY (worker).

export const HEADER = {
  WRITE: 0, // frames written so far
  READ: 1, // frames played so far (counted from the run's start; skipped frames count too)
  UNDERRUNS: 2, // render quanta the player had too little audio for
  STOP: 3, // 1: the run is over; the worker stops waiting for the player
  STARTED: 5, // 1 once the player has played its first block
};
export const HEADER_INTS = 8;
export const CAPACITY = 1 << 16; // frames: 1.37 s at 48 kHz, more than the worker ever runs ahead

export const MAIL = { STATE: 0, LEN: 1 };
export const MAIL_STATE = { EMPTY: 0, WRITING: 1, FULL: 2, READING: 3 };
const MAIL_HEADER_BYTES = 8;
export const MAIL_BYTES = 8 << 20; // the largest command: every part's orders as JSON

export function createRing() {
  return new SharedArrayBuffer(HEADER_INTS * 4 + 2 * CAPACITY * 4);
}

export function ringViews(sab) {
  return {
    header: new Int32Array(sab, 0, HEADER_INTS),
    left: new Float32Array(sab, HEADER_INTS * 4, CAPACITY),
    right: new Float32Array(sab, HEADER_INTS * 4 + CAPACITY * 4, CAPACITY),
  };
}

export function createMailbox() {
  return new SharedArrayBuffer(MAIL_HEADER_BYTES + MAIL_BYTES);
}

export function mailViews(sab) {
  return { header: new Int32Array(sab, 0, 2), data: new Uint8Array(sab, MAIL_HEADER_BYTES) };
}

/** Main thread: put `bytes` in the mailbox, replacing a command not yet read. False while the worker is reading (try again). */
export function postMail({ header, data }, bytes) {
  if (bytes.length > data.length) throw new Error('the song is too large to play');
  for (const from of [MAIL_STATE.EMPTY, MAIL_STATE.FULL]) {
    if (Atomics.compareExchange(header, MAIL.STATE, from, MAIL_STATE.WRITING) === from) {
      data.set(bytes);
      Atomics.store(header, MAIL.LEN, bytes.length);
      Atomics.store(header, MAIL.STATE, MAIL_STATE.FULL);
      return true;
    }
  }
  return false;
}

/** Worker: the size of the command waiting (taking it for reading), or 0. */
export function takeMail({ header }) {
  if (Atomics.compareExchange(header, MAIL.STATE, MAIL_STATE.FULL, MAIL_STATE.READING) !== MAIL_STATE.FULL) return 0;
  return Atomics.load(header, MAIL.LEN);
}

/** Worker: copy the command taken with takeMail into `into`, and free the slot. */
export function readMail({ header, data }, into) {
  into.set(data.subarray(0, Atomics.load(header, MAIL.LEN)));
  Atomics.store(header, MAIL.STATE, MAIL_STATE.EMPTY);
}
