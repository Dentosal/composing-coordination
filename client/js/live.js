// Live preview of the player's own draft: a look-ahead sequencer that plays the pattern with live voices (voice.js)
// on the shared AudioContext, in step with the band mix. Nothing is rendered ahead of time, so edits to notes and
// to the patch are heard within one look-ahead window. Has the same transport surface as LoopPlayer
// (play / stop / position / loopRegion / playing) so game.js can drive either.
import { getBus, getCtx, unlock } from './audio.js';
import { Master, midiHz, noiseBuffer, startVoice } from './voice.js';
import { notePlan, paramTarget } from './fx.js';

const LOOK_AHEAD = 0.1; // seconds scheduled ahead
const TICK_MS = 25;
const LATE = 0.05; // rows already this far in the past (throttled timer) are dropped, not played in a burst
const FADE = 0.02;

export class LiveSequencer {
  /** @param {{config:()=>object, seat:()=>number, part:()=>import('./types.js').Orders|null}} src
   *  `part()` is read on every tick: the orders to play right now (muted tracks already left out). */
  constructor(src) {
    this.src = src;
    this.playing = false;
    this.run = null;
    this.noise = new Map(); // "inst:node:color" -> AudioBuffer
  }

  /** Always ready: there is nothing to render first. */
  get buffer() {
    return true;
  }

  /** Start looping at AudioContext time `when` (default: just now), optionally part-way in or over a slice. */
  async play(when, region) {
    if (this.playing) return;
    const ctx = await unlock();
    if (this.playing) return;
    const cfg = this.src.config();
    const rowSecs = 60 / (cfg.bpm * (cfg.rows_per_bar / 4));
    const total = cfg.bars * cfg.rows_per_bar;
    const toRow = (s) => Math.round(s / rowSecs);
    const lsRow = Math.min(Math.max(toRow(region?.loopStart ?? 0), 0), total - 1);
    const leRow = Math.min(Math.max(toRow(region?.loopEnd ?? total * rowSecs), lsRow + 1), total);
    const offRow = Math.min(Math.max(toRow(region?.offset ?? 0), lsRow), leRow - 1);
    const out = ctx.createGain();
    out.connect(getBus());
    const run = {
      start: when ?? ctx.currentTime + 0.05, rowSecs, lsRow, leRow, offRow, n: 0, total, out,
      master: new Master(ctx, cfg, out), timer: null,
    };
    run.timer = setInterval(() => this.tick(), TICK_MS);
    this.run = run;
    this.playing = true;
    this.tick();
  }

  stop() {
    const r = this.run;
    if (!r) return;
    clearInterval(r.timer);
    this.run = null;
    this.playing = false;
    const t = getCtx().currentTime;
    r.out.gain.setValueAtTime(r.out.gain.value, t);
    r.out.gain.linearRampToValueAtTime(0, t + FADE);
    setTimeout(() => r.out.disconnect(), 400);
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

  tick() {
    const r = this.run;
    if (!r) return;
    const ctx = getCtx();
    const first = r.leRow - r.offRow;
    for (;;) {
      const t = r.start + r.n * r.rowSecs;
      if (t >= ctx.currentTime + LOOK_AHEAD) break;
      const row = r.n < first ? r.offRow + r.n : r.lsRow + ((r.n - first) % (r.leRow - r.lsRow));
      r.n++;
      if (t < ctx.currentTime - LATE) continue;
      try {
        this.scheduleRow(ctx, r, row, t);
      } catch (e) {
        console.error('live preview:', e);
      }
    }
  }

  scheduleRow(ctx, r, row, t) {
    const part = this.src.part();
    if (!part) return;
    const seed = this.src.config().seed;
    scheduleRow(ctx, r.master, part, { rowSecs: r.rowSecs, total: r.total, leRow: r.leRow }, row, t, (inst) => this.noiseFor(ctx, inst, seed));
  }

  noiseFor(ctx, inst, seed) {
    const map = new Map();
    for (const n of inst.nodes) {
      if (n.type !== 'noise') continue;
      const key = `${inst.id}:${n.id}:${n.color}`;
      if (!this.noise.has(key)) this.noise.set(key, noiseBuffer(ctx, seed, this.src.seat(), inst.id, n.id, n.color));
      map.set(n.id, this.noise.get(key));
    }
    return map;
  }
}

/**
 * Start the voices for the notes of `part` that begin at pattern row `row`, at AudioContext time `t`. Shared by the
 * live sequencer and the offline renderer (offline.js), so both play notes the same way. `leRow` is the end of the
 * looped slice (a note is cut there; pass `total` when nothing loops). `noiseFor(inst)` gives the instrument's noise buffers.
 * @param {{rowSecs:number,total:number,leRow:number}} timing
 */
export function scheduleRow(ctx, master, part, { rowSecs, total, leRow }, row, t, noiseFor) {
  for (const lane of part.lanes) {
    let on = null;
    let next = total; // the note ends at the next step of the lane (note-on or note-off), or the pattern's end
    for (const s of lane.steps) {
      if (s.row >= total) continue;
      if (s.row === row) on = s;
      else if (s.row > row && s.row < next) next = s.row;
    }
    if (!on || on.note == null) continue;
    const inst = part.instruments.find((i) => i.id === lane.instrument);
    if (!inst) continue;
    const endRow = row < leRow ? Math.min(next, leRow) : next; // a looped slice cuts the note at its end
    // Effect cells can split the note into several voices (retrigger) and end it early (cut); each voice carries its
    // own volume / pitch automation.
    const hz = midiHz(on.note);
    for (const seg of notePlan(lane.fx, row, endRow, rowSecs, (node, port) => paramTarget(inst, hz, node, port))) {
      startVoice(ctx, master.bus(ctx, inst), inst, noiseFor(inst), on.note, on.vel, t + seg.start, seg)
        .release(t + seg.end);
    }
  }
}
