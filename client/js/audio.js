// Web Audio plumbing: shared AudioContext and a seamless loop player.

let ctx = null;
const CROSSFADE = 0.015; // seconds

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

/**
 * The shared output: everything audible (band mix, preview, audition) plays into this bus, which feeds an analyser
 * (for the footer's spectrum display) and then the speakers.
 */
let bus = null;
let analyser = null;
export function getBus() {
  const c = getCtx();
  if (!bus) {
    bus = c.createGain();
    analyser = c.createAnalyser();
    analyser.fftSize = 2048;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -25;
    analyser.smoothingTimeConstant = 0.75;
    bus.connect(analyser);
    analyser.connect(c.destination);
  }
  return bus;
}

/** The output analyser, or null before any audio has been set up (nothing has played yet). */
export function peekAnalyser() {
  return analyser;
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
      this.out.connect(getBus());
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
    const g = c.createGain(); // per-source gain, so a replacement can be crossfaded
    src.connect(g).connect(this._out());
    src.start(when, r.offset);
    return { src, g, start: when, dur, region: r };
  }

  /** The current loop slice, as a region that starts at its beginning (what a late joiner should use). */
  loopRegion() {
    const r = this.cur?.region;
    return r ? { offset: r.loopStart, loopStart: r.loopStart, loopEnd: r.loopEnd } : undefined;
  }

  /**
   * Replace the looped buffer. By default the new one takes over at the next loop boundary (stays on the beat).
   * With `immediate`, it takes over right now at the same loop position (same-length buffers stay in sync),
   * with a short crossfade: for hearing edits as soon as they are rendered.
   */
  setBuffer(buffer, immediate = false) {
    this.buffer = buffer;
    if (!this.playing) return;
    if (immediate) return this._swapNow(buffer);
    const boundary = this.nextBoundary();
    if (this.pending) this.pending.src.stop();
    this.cur.src.stop(boundary);
    this.pending = this._startSource(buffer, boundary, this.loopRegion());
  }

  _swapNow(buffer) {
    const c = getCtx();
    this._promote();
    if (this.pending) this.pending.src.stop();
    this.pending = null;
    const old = this.cur;
    if (c.currentTime < old.start) { // not audible yet: replace outright
      old.src.stop();
      this.cur = this._startSource(buffer, old.start, old.region);
      return;
    }
    const when = c.currentTime + 0.01;
    const next = this._startSource(buffer, when, { ...old.region, offset: this._posAfter(old, when - old.start) });
    const end = when + CROSSFADE;
    next.g.gain.setValueAtTime(0, when);
    next.g.gain.linearRampToValueAtTime(1, end);
    old.g.gain.setValueAtTime(1, when);
    old.g.gain.linearRampToValueAtTime(0, end);
    old.src.stop(end + 0.01);
    this.cur = next;
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
