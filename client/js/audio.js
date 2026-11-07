// Web Audio plumbing: shared AudioContext and a seamless loop player.

let ctx = null;

export function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  return ctx;
}

/** Call from a user gesture (join / start / play click). */
export async function unlock() {
  const c = getCtx();
  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {}
  }
  return c;
}

export function decode(arrayBuffer) {
  return getCtx().decodeAudioData(arrayBuffer);
}

/**
 * Loops one AudioBuffer. A new buffer swaps in at the next loop boundary so the
 * transition between round mixes stays on the beat.
 */
export class LoopPlayer {
  constructor() {
    this.buffer = null;
    this.playing = false;
    this.cur = null; // {src, start, dur}
    this.pending = null;
    this.out = null;
  }

  _out() {
    const c = getCtx();
    if (!this.out) {
      this.out = c.createGain();
      this.out.connect(c.destination);
    }
    return this.out;
  }

  _startSource(buffer, when) {
    const c = getCtx();
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this._out());
    src.start(when);
    return { src, start: when, dur: buffer.duration };
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    if (!this.playing) return;
    const c = getCtx();
    this._promote();
    const { start, dur } = this.cur;
    const boundary = start + Math.max(1, Math.ceil((c.currentTime - start) / dur + 1e-6)) * dur;
    if (this.pending) this.pending.src.stop();
    this.cur.src.stop(boundary);
    this.pending = this._startSource(buffer, boundary);
  }

  async play() {
    if (!this.buffer || this.playing) return;
    const c = await unlock();
    this.cur = this._startSource(this.buffer, c.currentTime + 0.05);
    this.pending = null;
    this.playing = true;
  }

  stop() {
    if (!this.playing) return;
    this.cur?.src.stop();
    this.pending?.src.stop();
    this.cur = this.pending = null;
    this.playing = false;
  }

  _promote() {
    if (this.pending && getCtx().currentTime >= this.pending.start) {
      this.cur = this.pending;
      this.pending = null;
    }
  }

  /** Seconds into the current loop, or null when not audibly playing. */
  position() {
    if (!this.playing || !this.cur) return null;
    this._promote();
    const t = getCtx().currentTime - this.cur.start;
    if (t < 0) return null;
    return t % this.cur.dur;
  }
}
