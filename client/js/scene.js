// The "scene" file: everything of a session's tracks (patches, notes, effects) as one JSON file, written by the
// header's export button and read back on the start page to open it in a fresh freeform session.

export const SCENE_FORMAT = 'band-game-tracks';
const MAX_BYTES = 1024 * 1024; // the server takes bodies up to 1 MiB
const MAX_BARS = 64; // the longest freeform song

/** The file's content for a session config and its (draft) orders. */
export function sceneFile(cfg, orders, now = new Date()) {
  return {
    format: SCENE_FORMAT,
    version: 1,
    exported: now.toISOString(),
    // The seed (as text, it can exceed what a JSON number holds exactly) decides the noise and the reverb.
    config: { bpm: cfg.bpm, bars: cfg.bars, rows_per_bar: cfg.rows_per_bar, seed: String(cfg.seed) },
    orders: { instruments: orders.instruments, lanes: orders.lanes },
  };
}

/**
 * Parse a scene file. Throws an Error with a readable message when it is not one. The server still validates the
 * orders themselves when they are saved.
 * @returns {{config:{bpm:number,bars:number,rows_per_bar:number,seed:number|null}, orders:{instruments:any[],lanes:any[]}}}
 */
export function readSceneFile(text) {
  if (text.length > MAX_BYTES) throw new Error('That file is too large to be a scene.');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (raw?.format !== SCENE_FORMAT) throw new Error('That is not a scene file exported from this game (use the download button in the header).');
  const c = raw.config;
  const o = raw.orders;
  if (!c || typeof c !== 'object') throw new Error('The scene has no tempo or length settings.');
  if (!Number.isFinite(c.bpm) || c.bpm < 40 || c.bpm > 240) throw new Error('The scene\'s tempo (bpm) must be between 40 and 240.');
  if (!Number.isInteger(c.bars) || c.bars < 1 || c.bars > MAX_BARS) throw new Error(`The scene's length must be 1 to ${MAX_BARS} bars.`);
  if (!Number.isInteger(c.rows_per_bar) || c.rows_per_bar < 4 || c.rows_per_bar > 32 || c.rows_per_bar % 4) {
    throw new Error('The scene\'s rows per bar must be a multiple of 4 from 4 to 32.');
  }
  if (!o || !Array.isArray(o.instruments) || !Array.isArray(o.lanes)) throw new Error('The scene has no tracks.');
  if (!o.lanes.length) throw new Error('The scene has no tracks.');
  // Keep the seed only when it is exact as a number; otherwise the session gets a fresh one.
  const seed = Number(c.seed);
  return {
    config: { bpm: c.bpm, bars: c.bars, rows_per_bar: c.rows_per_bar, seed: Number.isSafeInteger(seed) && seed >= 0 ? seed : null },
    orders: { instruments: o.instruments, lanes: o.lanes },
  };
}
