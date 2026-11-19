// Streaming player: plays the parts with the server's own renderer, compiled to WebAssembly (client/wasm/renderer.wasm),
// running live in a worker (live-worker.js) a short way ahead of playback; an AudioWorklet (stream-processor.js) copies
// the audio out on the audio thread. So the browser's audio thread never synthesizes anything (no crackle when a busy
// bar starts, in any browser), and what plays is exactly what the server renders.
//
// It has the live sequencer's transport surface (play / stop / position / loopRegion / playing / buffer), so game.js
// drives it like the band-mix LoopPlayer. Edits: call changed() and the next rows not yet rendered use them (about
// AHEAD_SECS later). Needs a cross-origin isolated page (SharedArrayBuffer); the server sends the headers.
import { getBus, getCtx, unlock } from './audio.js';
import { CAPACITY, HEADER, createMailbox, createRing, mailViews, postMail, ringViews } from './ring.js';

const AHEAD_SECS = 0.1; // how far the renderer runs ahead of playback: the edit latency, and the slack for a slow block
const FADE = 0.02;
const WASM_URL = new URL('../wasm/renderer.wasm', import.meta.url).href;
const PROCESSOR_URL = new URL('./stream-processor.js', import.meta.url);

export class StreamPlayer {
  /** @param {{config:()=>object, parts:()=>{seat:number,orders:import('./types.js').Orders}[]}} src
   *  `parts()` is read at the start and on every changed(): the parts to play (muted tracks already left out). */
  constructor(src) {
    this.src = src;
    this.playing = false;
    this.run = null;
    this.worker = null;
    this.worklet = null; // the promise of the processor module, once added
    this.error = '';
    this.sendT = null;
  }

  /** Always ready: nothing is rendered before playing. */
  get buffer() {
    return true;
  }

  /** True where the page can stream (a cross-origin isolated page, with AudioWorklet). */
  static get supported() {
    return !!self.crossOriginIsolated && typeof AudioWorkletNode !== 'undefined';
  }

  /** Start the worker and load the renderer, so the first play starts quickly. */
  warm() {
    if (this.worker || !StreamPlayer.supported) return;
    this.worker = new Worker(new URL('./live-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.error) {
        this.error = data.error;
        console.error('[stream]', data.error);
      }
    };
    this.worker.postMessage({ compile: WASM_URL });
  }

  /** Start looping at AudioContext time `when` (default: just now), optionally part-way in or over a slice. */
  async play(when, region) {
    if (this.playing) return;
    this.warm();
    const ctx = await unlock();
    if (this.playing) return;
    this.worklet ??= ctx.audioWorklet.addModule(PROCESSOR_URL);
    await this.worklet;
    if (this.playing) return;
    const cfg = this.src.config();
    const rowSecs = 60 / (cfg.bpm * (cfg.rows_per_bar / 4));
    const total = cfg.bars * cfg.rows_per_bar;
    const toRow = (s) => Math.round(s / rowSecs);
    const lsRow = Math.min(Math.max(toRow(region?.loopStart ?? 0), 0), total - 1);
    const leRow = Math.min(Math.max(toRow(region?.loopEnd ?? total * rowSecs), lsRow + 1), total);
    const offRow = Math.min(Math.max(toRow(region?.offset ?? 0), lsRow), leRow - 1);
    const start = when ?? ctx.currentTime + 0.05;

    const ring = createRing();
    const mail = createMailbox();
    const run = { start, rowSecs, lsRow, leRow, offRow, ring, mail, header: ringViews(ring).header, mailbox: mailViews(mail), lastSent: null };
    this.send(run); // the parts: the first command
    const node = new AudioWorkletNode(ctx, 'ring-player', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { ring, capacity: CAPACITY, startFrame: Math.round(start * ctx.sampleRate) },
    });
    const out = ctx.createGain();
    node.connect(out).connect(getBus());
    run.node = node;
    run.out = out;
    this.worker.postMessage({
      run: {
        wasmUrl: WASM_URL, ring, mail, aheadFrames: Math.round(AHEAD_SECS * ctx.sampleRate),
        cfg: { bpm: cfg.bpm, bars: cfg.bars, rows_per_bar: cfg.rows_per_bar, seed: cfg.seed },
        transport: { start: offRow, loopStart: lsRow, loopEnd: leRow },
      },
    });
    this.run = run;
    this.playing = true;
  }

  stop() {
    const r = this.run;
    if (!r) return;
    this.run = null;
    this.playing = false;
    clearTimeout(this.sendT);
    Atomics.store(r.header, HEADER.STOP, 1);
    Atomics.notify(r.header, HEADER.READ);
    const stopCmd = new TextEncoder().encode('{"stop":true}');
    const post = () => { if (!postMail(r.mailbox, stopCmd)) setTimeout(post, 2); };
    post();
    const t = getCtx().currentTime;
    r.out.gain.setValueAtTime(r.out.gain.value, t);
    r.out.gain.linearRampToValueAtTime(0, t + FADE);
    setTimeout(() => { r.node.disconnect(); r.out.disconnect(); }, 200);
  }

  /** The parts changed (an edit, a mute or solo): play the new ones from the next rows not yet rendered. */
  changed() {
    if (!this.run) return;
    clearTimeout(this.sendT);
    this.sendT = setTimeout(() => this.run && this.send(this.run), 0); // several changes in one task: one command
  }

  send(run) {
    const json = JSON.stringify({ parts: this.src.parts() });
    if (json === run.lastSent) return;
    const bytes = new TextEncoder().encode(json);
    if (postMail(run.mailbox, bytes)) run.lastSent = json;
    else this.sendT = setTimeout(() => this.run === run && this.send(run), 2); // the worker is reading the last one
  }

  /** Stop, and end the worker. */
  destroy() {
    this.stop();
    const w = this.worker;
    this.worker = null;
    setTimeout(() => w?.terminate(), 300); // after the stop has reached it
  }

  /** The current loop slice as a region that starts at its beginning. */
  loopRegion() {
    const r = this.run;
    return r && { offset: r.lsRow * r.rowSecs, loopStart: r.lsRow * r.rowSecs, loopEnd: r.leRow * r.rowSecs };
  }

  /** Seconds into the pattern (the audible position), or null when not audibly playing. */
  position() {
    const r = this.run;
    if (!r) return null;
    const e = getCtx().currentTime - r.start;
    if (e < 0) return null;
    const p = r.offRow * r.rowSecs + e;
    const end = r.leRow * r.rowSecs;
    if (p < end) return p;
    const ls = r.lsRow * r.rowSecs;
    return ls + ((p - ls) % (end - ls));
  }

  /** Playback health, for diagnostics: underruns so far and how much audio is buffered ahead (seconds). */
  stats() {
    const r = this.run;
    if (!r) return null;
    const write = Atomics.load(r.header, HEADER.WRITE);
    const read = Atomics.load(r.header, HEADER.READ);
    return { underruns: Atomics.load(r.header, HEADER.UNDERRUNS), ahead: (write - read) / getCtx().sampleRate };
  }
}
