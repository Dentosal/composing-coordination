// Client-side twin of the server's preview render (server/src/render/mod.rs `render_preview`): one seat's orders
// rendered offline through the shared voice/master code, two loops back to back, keeping the second so reverb,
// delay and release tails wrap into the loop start. Returns an AudioBuffer for LoopPlayer.
import { getCtx } from './audio.js';
import { Master, noiseBuffer, startVoice } from './voice.js';

export const RENDER_RATE = 48000;
const TAIL_SECS = 6; // reverb (1.8 s) plus delay feedback repeats, with margin
const maxRelease = (inst) => Math.max(0, ...inst.nodes.filter((n) => n.type === 'env').map((n) => n.release));

/** (note, vel, startRow, endRow) per note-on; mirrors lane_notes() in server/src/render/voice.rs. */
export function laneNotes(lane, totalRows) {
  const steps = lane.steps.filter((s) => s.row < totalRows).sort((a, b) => a.row - b.row);
  const out = [];
  steps.forEach((s, i) => {
    if (s.note == null) return;
    const end = steps[i + 1]?.row ?? totalRows;
    if (end > s.row) out.push([s.note, s.vel, s.row, end]);
  });
  return out;
}

/** @param {import('./types.js').Orders} orders @param {{bpm:number,bars:number,rows_per_bar:number,seed:number}} cfg */
export async function renderPreviewLocal(orders, cfg, seatIndex) {
  const totalRows = cfg.bars * cfg.rows_per_bar;
  const rowSecs = 60 / (cfg.bpm * (cfg.rows_per_bar / 4));
  const frames = Math.round(rowSecs * totalRows * RENDER_RATE);
  const loopSecs = rowSecs * totalRows;
  const ctx = new OfflineAudioContext(2, frames * 2, RENDER_RATE);
  const master = new Master(ctx, cfg);
  const insts = new Map(orders.instruments.map((i) => [i.id, i]));
  const buses = new Map();
  const noise = new Map();
  for (const inst of orders.instruments) {
    buses.set(inst.id, master.bus(ctx, inst));
    const m = new Map();
    for (const n of inst.nodes) if (n.type === 'noise') m.set(n.id, noiseBuffer(ctx, cfg.seed, seatIndex, inst.id, n.id, n.color));
    noise.set(inst.id, m);
  }
  for (const lane of orders.lanes) {
    const inst = insts.get(lane.instrument);
    if (!inst) continue;
    for (const [note, vel, row, endRow] of laneNotes(lane, totalRows)) {
      // Both copies of the loop, so the first one's tails land in the second. A first-copy note that has fully died
      // away by the loop end (release + reverb/delay tail) cannot matter, so skip it.
      for (let k = endRow * rowSecs + maxRelease(inst) + TAIL_SECS < loopSecs ? 1 : 0; k < 2; k++) {
        const off = k * loopSecs;
        startVoice(ctx, buses.get(inst.id), inst, noise.get(inst.id), note, vel, off + row * rowSecs).release(off + endRow * rowSecs);
      }
    }
  }
  const full = await ctx.startRendering();
  const out = getCtx().createBuffer(2, frames, RENDER_RATE);
  for (let c = 0; c < 2; c++) out.copyToChannel(full.getChannelData(c).subarray(frames, frames * 2), c);
  return out;
}
