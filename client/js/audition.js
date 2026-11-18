// Plays notes of one instrument on demand: once, held while a button is down, or repeated at a
// multiple of the session BPM. Uses the live voices in voice.js.
import { getBus, getCtx, unlock } from './audio.js';
import { Master, noiseBuffer, startVoice } from './voice.js';

const LOOK_AHEAD = 0.12; // seconds scheduled ahead while looping
const TICK_MS = 25;
const START_DELAY = 0.03;

export class Auditioner {
  /** @param {{bpm:number,seed:number}} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.master = null;
    this.noise = new Map(); // "inst:node:color" -> AudioBuffer
    this.loopId = null; // id of the instrument currently looping, or null
    this.timer = null;
    this.holds = new Set();
  }

  async ready() {
    const ctx = await unlock();
    this.master ??= new Master(ctx, this.cfg, getBus());
    return ctx;
  }

  noiseFor(ctx, inst) {
    const map = new Map();
    for (const n of inst.nodes) {
      if (n.type !== 'noise') continue;
      const key = `${inst.id}:${n.id}:${n.color}`;
      if (!this.noise.has(key)) this.noise.set(key, noiseBuffer(ctx, this.cfg.seed, 0, inst.id, n.id, n.color));
      map.set(n.id, this.noise.get(key));
    }
    return map;
  }

  voice(ctx, inst, note, vel, t0) {
    return startVoice(ctx, this.master.bus(ctx, inst), inst, this.noiseFor(ctx, inst), note, vel, t0);
  }

  /** One note, one beat long. */
  async once(inst, note, vel) {
    const ctx = await this.ready();
    const t = ctx.currentTime + START_DELAY;
    this.voice(ctx, inst, note, vel, t).release(t + 60 / this.cfg.bpm);
  }

  /** Start a note that sounds until the returned handle's release() is called. */
  async hold(inst, note, vel) {
    const ctx = await this.ready();
    const v = this.voice(ctx, inst, note, vel, ctx.currentTime + START_DELAY);
    const handle = {
      release: () => {
        this.holds.delete(handle);
        v.release(getCtx().currentTime);
      },
    };
    this.holds.add(handle);
    return handle;
  }

  /**
   * Repeat a note every beat/mult seconds (gate: half the interval) until stopLoop().
   * `get()` returns { inst, note, vel, mult } and is read on every repeat, so edits are heard on the next one.
   */
  async startLoop(id, get) {
    this.stopLoop();
    const ctx = await this.ready();
    this.loopId = id;
    let next = ctx.currentTime + START_DELAY;
    this.timer = setInterval(() => {
      const cur = get();
      if (!cur.inst) return this.stopLoop();
      while (next < ctx.currentTime + LOOK_AHEAD) {
        const interval = 60 / this.cfg.bpm / cur.mult;
        this.voice(ctx, cur.inst, cur.note, cur.vel, next).release(next + interval / 2);
        next += interval;
      }
    }, TICK_MS);
  }

  stopLoop() {
    clearInterval(this.timer);
    this.timer = null;
    this.loopId = null;
  }

  stopAll() {
    this.stopLoop();
    for (const h of [...this.holds]) h.release();
  }
}
