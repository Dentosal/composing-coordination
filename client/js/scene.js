// The "scene" file: everything of a session's tracks (patches, notes, effects) as one JSON file, written by the
// header's export button and read back on the start page to open it in a fresh freeform session.

export const SCENE_FORMAT = 'band-game-tracks';
const MAX_BYTES = 16 * 1024 * 1024; // the server takes bodies up to 16 MiB (a whole game's scene can be several)
const MAX_BARS = 256; // the longest freeform song
const ROWS_PER_BAR = 16; // every session's (the server's ROWS_PER_BAR)

/**
 * The file's content for a session config and its (draft) orders. `build` is what GET /api/version said (the git
 * commits of the server and of the client files, with a "+fingerprint" when there were uncommitted changes), so a file
 * that misbehaves can be traced to the code that wrote it.
 */
export function sceneFile(cfg, orders, build = null, now = new Date()) {
  return {
    format: SCENE_FORMAT,
    version: 1, // the file layout
    exported: now.toISOString(),
    build: { server: build?.server?.label ?? 'unknown', client: build?.client?.label ?? 'unknown' },
    // The seed (as text, it can exceed what a JSON number holds exactly) decides the noise and the reverb.
    config: { bpm: cfg.bpm, bars: cfg.bars, rows_per_bar: cfg.rows_per_bar, seed: String(cfg.seed) },
    orders: { instruments: orders.instruments, lanes: orders.lanes },
  };
}

/**
 * Parse a scene file. Throws an Error with a readable message when it is not one. The server still validates the
 * orders themselves when they are saved.
 * @returns {{config:{bpm:number,bars:number,rows_per_bar:number,seed:string|null}, orders:{instruments:any[],lanes:any[]}}}
 */
export function readSceneFile(text) {
  if (text.length > MAX_BYTES) throw new Error('That file is too large to be a scene.');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (raw?.format !== SCENE_FORMAT) throw new Error('That is not a scene file exported from this game (save one from the download menu in the header).');
  const c = raw.config;
  const o = raw.orders;
  if (!c || typeof c !== 'object') throw new Error('The scene has no tempo or length settings.');
  if (!Number.isFinite(c.bpm) || c.bpm < 40 || c.bpm > 240) throw new Error('The scene\'s tempo (bpm) must be between 40 and 240.');
  if (!Number.isInteger(c.bars) || c.bars < 1 || c.bars > MAX_BARS) throw new Error(`The scene's length must be 1 to ${MAX_BARS} bars.`);
  // Sessions used to have a choice of rows per bar; now it is always 16. An older file without the setting had 16 too.
  if ((c.rows_per_bar ?? ROWS_PER_BAR) !== ROWS_PER_BAR) {
    throw new Error(`The scene has ${c.rows_per_bar} rows per bar; only ${ROWS_PER_BAR} can be opened.`);
  }
  if (!o || !Array.isArray(o.instruments) || !Array.isArray(o.lanes)) throw new Error('The scene has no tracks.');
  if (!o.lanes.length) throw new Error('The scene has no tracks.');
  // The seed is text in the file (it can exceed what a JSON number holds exactly). An older file has none, or a plain number.
  const seedText = String(c.seed ?? '').trim();
  const seed = /^\d{1,20}$/.test(seedText) && BigInt(seedText) <= 18446744073709551615n ? seedText : null;
  return {
    config: { bpm: c.bpm, bars: c.bars, rows_per_bar: ROWS_PER_BAR, seed },
    orders: { instruments: o.instruments, lanes: o.lanes },
  };
}
