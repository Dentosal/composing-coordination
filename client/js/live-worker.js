// Module worker for the streaming player (stream.js): runs the renderer's live playback (WebAssembly, live_run) and
// writes the audio into the shared ring as it renders, staying at most `aheadFrames` ahead of what the audio thread
// has played. Commands (edits, stop) come through the shared mailbox, which the renderer reads between blocks: while it
// renders, this worker cannot take messages. Blocking is fine here (it is a worker): Atomics.wait is how it keeps pace.
//
// Messages in:  { compile: wasmUrl } to load the renderer early; { run: { wasmUrl, ring, mail, aheadFrames, cfg, transport } }.
// Messages out: { done } when a run has stopped, { error } when it failed.
import { CAPACITY, HEADER, mailViews, readMail, ringViews, takeMail } from './ring.js';

let compiled = null;
const compile = async (url) => {
  if (!compiled) {
    compiled = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`the renderer could not be loaded (${r.status})`);
      return WebAssembly.compile(await r.arrayBuffer());
    })();
    compiled.catch(() => { compiled = null; });
  }
  return compiled;
};

self.onmessage = async ({ data }) => {
  if (data.compile) {
    compile(data.compile).catch(() => {});
    return;
  }
  const { wasmUrl, ring, mail, aheadFrames, cfg, transport } = data.run;
  const { header, left, right } = ringViews(ring);
  const mailbox = mailViews(mail);
  let message = '';
  let exports = null;
  const emit = (lp, rp, n) => {
    let write = Atomics.load(header, HEADER.WRITE);
    // Stay at most aheadFrames ahead of playback: wait for the player to catch up (unless the run is over: then the
    // renderer only has to get to its next look at the mailbox, where the stop command is).
    for (;;) {
      if (Atomics.load(header, HEADER.STOP)) return;
      const read = Atomics.load(header, HEADER.READ);
      if (write + n - read <= aheadFrames) break;
      Atomics.wait(header, HEADER.READ, read, 20);
    }
    const mem = exports.memory.buffer;
    const l = new Float32Array(mem, lp, n);
    const r = new Float32Array(mem, rp, n);
    const at = write % CAPACITY;
    const first = Math.min(n, CAPACITY - at);
    left.set(l.subarray(0, first), at);
    right.set(r.subarray(0, first), at);
    if (first < n) {
      left.set(l.subarray(first), 0);
      right.set(r.subarray(first), 0);
    }
    Atomics.store(header, HEADER.WRITE, write + n);
  };
  try {
    // A fresh instance per run: its memory (which only ever grows) is freed with it.
    const instance = await WebAssembly.instantiate(await compile(wasmUrl), {
      env: {
        progress: () => {},
        report_error: (ptr, len) => { message = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len)); },
        emit,
        cmd_len: () => takeMail(mailbox),
        cmd_read: (ptr) => readMail(mailbox, new Uint8Array(exports.memory.buffer, ptr, Atomics.load(mailbox.header, 1))),
      },
    });
    exports = instance.exports;
    const ok = exports.live_run(cfg.bpm, cfg.bars, cfg.rows_per_bar, BigInt(String(cfg.seed)), transport.start, transport.loopStart, transport.loopEnd);
    if (!ok) throw new Error(message || 'playback failed');
    self.postMessage({ done: true });
  } catch (e) {
    self.postMessage({ error: message || e?.message || String(e) });
  }
};
