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
 *
 * A "region" {offset, loopStart, loopEnd} (seconds) starts playback part-way in and/or loops only a slice of the
 * buffer. The default is the whole buffer from the start.
 */
export class LoopPlayer {
  constructor() {
    this.buffer = null;
    this.playing = false;
    this.cur = null; // {src, start, dur, region}
    this.pending = null;
    this.out = null;
    this.muted = false;
  }

  _out() {
    const c = getCtx();
    if (!this.out) {
      this.out = c.createGain();
      this.out.gain.value = this.muted ? 0 : 1;
      this.out.connect(c.destination);
    }
    return this.out;
  }

  /** Silence (or restore) the output without stopping playback, so the loop keeps its position. */
  setMuted(muted) {
    this.muted = muted;
    if (this.out) this.out.gain.value = muted ? 0 : 1;
  }

  _startSource(buffer, when, region) {
    const c = getCtx();
    const dur = buffer.duration;
    const loopEnd = Math.min(region?.loopEnd ?? dur, dur);
    const loopStart = Math.min(region?.loopStart ?? 0, loopEnd);
    const r = { offset: Math.min(region?.offset ?? 0, loopEnd), loopStart, loopEnd };
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = r.loopStart;
    src.loopEnd = r.loopEnd;
    src.connect(this._out());
    src.start(when, r.offset);
    return { src, start: when, dur, region: r };
  }

  /** The current loop slice, as a region that starts at its beginning (what a late joiner should use). */
  loopRegion() {
    const r = this.cur?.region;
    return r ? { offset: r.loopStart, loopStart: r.loopStart, loopEnd: r.loopEnd } : undefined;
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    if (!this.playing) return;
    const boundary = this.nextBoundary();
    if (this.pending) this.pending.src.stop();
    this.cur.src.stop(boundary);
    this.pending = this._startSource(buffer, boundary, this.loopRegion());
  }

  /** Position in the loop slice (seconds into the buffer) `e` seconds after the source started. */
  _posAfter(cur, e) {
    const { offset, loopStart, loopEnd } = cur.region;
    const p = offset + e;
    if (p < loopEnd) return p;
    const len = loopEnd - loopStart;
    return len > 0 ? loopStart + ((p - loopStart) % len) : loopStart;
  }

  /** AudioContext time of the next loop boundary (or the start, if the loop has not begun yet). */
  nextBoundary() {
    const c = getCtx();
    this._promote();
    const { start, region } = this.cur;
    if (c.currentTime < start) return region.offset === region.loopStart ? start : start + (region.loopEnd - region.offset);
    const len = Math.max(region.loopEnd - region.loopStart, 1e-3);
    const pos = this._posAfter(this.cur, c.currentTime - start);
    return c.currentTime + (region.loopEnd - pos > 1e-6 ? region.loopEnd - pos : len);
  }

  /** Start looping at AudioContext time `when` (default: just now). Players of equal-length loops
   *  started at the same `when`, or on each other's boundaries, stay in sync. */
  async play(when, region) {
    if (!this.buffer || this.playing) return;
    const c = await unlock();
    this.cur = this._startSource(this.buffer, when ?? c.currentTime + 0.05, region);
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

  /** Seconds into the buffer (the audible position), or null when not audibly playing. */
  position() {
    if (!this.playing || !this.cur) return null;
    this._promote();
    const e = getCtx().currentTime - this.cur.start;
    if (e < 0) return null;
    return this._posAfter(this.cur, e);
  }
}
