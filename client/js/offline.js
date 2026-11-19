// Renders a part to a song file in the browser: the same voices and note scheduling as the live preview (live.js,
// voice.js), on an OfflineAudioContext instead of the speakers. Like the server's song files (render_song in
// server/src/render/mod.rs), the pattern plays once from silence and then rings out for up to SONG_TAIL_SECS, with
// the trailing silence trimmed, as 16-bit stereo WAV at 48 kHz.
import { scheduleRow } from './live.js';
import { Master, noiseBuffer } from './voice.js';

const SAMPLE_RATE = 48000; // as the server renders
const SONG_TAIL_SECS = 4; // see SONG_TAIL_SECS in server/src/render/mod.rs
const SILENCE = 0.5 / 32767; // tail samples quieter than this round to 0 in 16-bit PCM
const CHUNK_SECS = 2; // notes are scheduled this far ahead, so a long song never holds all its voices at once

/**
 * Render `orders` (one seat's part, at join-order index `seat`) with session config `cfg` to WAV bytes.
 * `onProgress(fraction)` is called as rendering advances (in browsers that can suspend an offline render; otherwise
 * only at the end) and `onProgress(null)` once at the start where it will not be.
 * @param {{bpm:number,bars:number,rows_per_bar:number,seed:number|string}} cfg
 * @param {import('./types.js').Orders} orders
 * @returns {Promise<ArrayBuffer>}
 */
export async function renderSong(cfg, seat, orders, onProgress = () => {}) {
  const rowSecs = 60 / (cfg.bpm * (cfg.rows_per_bar / 4));
  const total = cfg.bars * cfg.rows_per_bar;
  const bodyFrames = Math.round(total * rowSecs * SAMPLE_RATE);
  const tailFrames = Math.round(SONG_TAIL_SECS * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, bodyFrames + tailFrames, SAMPLE_RATE);
  const master = new Master(ctx, cfg, ctx.destination);

  const noise = new Map(); // "inst:node:color" -> AudioBuffer
  const noiseFor = (inst) => {
    const map = new Map();
    for (const n of inst.nodes) {
      if (n.type !== 'noise') continue;
      const key = `${inst.id}:${n.id}:${n.color}`;
      if (!noise.has(key)) noise.set(key, noiseBuffer(ctx, cfg.seed, seat, inst.id, n.id, n.color));
      map.set(n.id, noise.get(key));
    }
    return map;
  };
  const timing = { rowSecs, total, leRow: total };
  let nextRow = 0;
  /** Schedule every row that starts before `until` seconds. */
  const scheduleUntil = (until) => {
    for (; nextRow < total && nextRow * rowSecs < until; nextRow++) scheduleRow(ctx, master, orders, timing, nextRow, nextRow * rowSecs, noiseFor);
  };

  // Suspend every CHUNK_SECS (on a render-quantum boundary, where suspending is exact) to schedule the next chunk's
  // notes, which all start at or after the suspend point: nothing is ever scheduled in the past. Browsers without
  // OfflineAudioContext.suspend (Firefox) get every note scheduled up front instead, and no progress until the end.
  const duration = (bodyFrames + tailFrames) / SAMPLE_RATE;
  const stops = [];
  if (typeof ctx.suspend === 'function') {
    for (let s = CHUNK_SECS; s < duration; s += CHUNK_SECS) stops.push(Math.floor((s * SAMPLE_RATE) / 128) * 128 / SAMPLE_RATE);
  }
  stops.forEach((at, i) => {
    ctx.suspend(at).then(() => {
      scheduleUntil(stops[i + 1] ?? Infinity);
      onProgress(at / duration);
      ctx.resume();
    });
  });
  scheduleUntil(stops[0] ?? Infinity);
  if (!stops.length && duration > CHUNK_SECS) onProgress(null);

  const buf = await ctx.startRendering();
  onProgress(1);
  const left = buf.getChannelData(0);
  const right = buf.getChannelData(1);
  let end = left.length;
  while (end > bodyFrames && Math.abs(left[end - 1]) <= SILENCE && Math.abs(right[end - 1]) <= SILENCE) end--;
  return encodeWav(left.subarray(0, end), right.subarray(0, end));
}

/** 16-bit PCM stereo WAV at 48 kHz, as server/src/render/wav.rs writes it. */
function encodeWav(left, right) {
  const frames = left.length;
  const out = new DataView(new ArrayBuffer(44 + frames * 4));
  const text = (at, s) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  out.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 2, true); // channels
  out.setUint32(24, SAMPLE_RATE, true);
  out.setUint32(28, SAMPLE_RATE * 4, true);
  out.setUint16(32, 4, true); // block align
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    out.setInt16(44 + i * 4, Math.round(Math.min(1, Math.max(-1, left[i])) * 32767), true);
    out.setInt16(46 + i * 4, Math.round(Math.min(1, Math.max(-1, right[i])) * 32767), true);
  }
  return out.buffer;
}
