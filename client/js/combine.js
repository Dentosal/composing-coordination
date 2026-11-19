// A game's rounds as one song: every player's tracks laid end to end over the rounds played. Used to play the song so far
// (each player's part over all rounds, through the streaming player) and for the combined scene file at the end, which
// opens in the freeform editor.
//
// A track in the song holds one sound (an instrument as set up, whatever it is called) of one player: a player who
// keeps a sound over several rounds keeps one track, and the game's sound budget (the server's `part_sounds`) bounds
// how many tracks that makes.

/** What makes two instruments the same sound: everything but the id, the display name and the piano-roll hint. */
export function soundKey(inst) {
  const { id, name, piano_roll, ...sound } = inst;
  return JSON.stringify(sound);
}

/**
 * The sounds a part plays: one per track with at least one note, as [key, k] where k counts the tracks before it in the
 * part with the same sound (two tracks of one sound need two tracks in the song). Must stay identical to `part_sounds`
 * in server/src/state.rs.
 */
export function partSounds(orders) {
  const seen = new Map();
  const out = [];
  for (const lane of orders.lanes ?? []) {
    if (!lane.steps?.some((s) => s.note != null)) continue;
    const inst = orders.instruments?.find((i) => i.id === lane.instrument);
    if (!inst) continue;
    const key = soundKey(inst);
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    out.push({ key: `${k}:${key}`, inst, lane });
  }
  return out;
}

const MAX_NAME = 32; // an instrument's display name (the server's limit)

/**
 * Lay the rounds end to end. `song` is GET /song-parts: {rounds: [{n, parts: [{seat, orders}]}], players: [{seat, name}]};
 * `cfg` the session config (bars, rows_per_bar per round).
 * @returns {{bars:number, parts:{seat:number, orders:object}[], merged:object}} `parts`: each player's part over the
 *   whole song, for playing with the right per-player noise; `merged`: all of them as one set of tracks, for a scene.
 */
export function combineRounds(song, cfg) {
  const rowsPerRound = cfg.bars * cfg.rows_per_bar;
  const rounds = song.rounds ?? [];
  const total = rounds.length * rowsPerRound;
  const nameOf = new Map((song.players ?? []).map((p) => [p.seat, p.name]));
  const seats = [...new Set(rounds.flatMap((r) => r.parts.map((p) => p.seat)))].sort((a, b) => a - b);
  const parts = [];
  for (const seat of seats) {
    const tracks = new Map(); // `${k}:${sound key}` -> {inst, lane, ends}
    rounds.forEach((round, ri) => {
      const part = round.parts.find((p) => p.seat === seat);
      if (!part) return;
      const offset = ri * rowsPerRound;
      for (const { key, inst, lane } of partSounds(part.orders)) {
        let t = tracks.get(key);
        if (!t) {
          const id = `p${seat}t${tracks.size + 1}`;
          const player = nameOf.get(seat) ?? `Player ${seat + 1}`;
          const name = `${player}: ${inst.name || inst.id}`.slice(0, MAX_NAME);
          t = { inst: { ...structuredClone(inst), id, name }, lane: { instrument: id, steps: [], fx: [] }, ends: [] };
          tracks.set(key, t);
        }
        for (const s of lane.steps) t.lane.steps.push({ ...s, row: s.row + offset });
        for (const f of lane.fx ?? []) t.lane.fx.push({ ...structuredClone(f), row: f.row + offset });
        t.ends.push(offset + rowsPerRound);
      }
    });
    const orders = { instruments: [], lanes: [] };
    for (const t of tracks.values()) {
      // A round's notes end with it (each loop is played on its own): stop a note still sounding at the round's end,
      // unless the track has a step of its own there (its next round).
      const rows = new Set(t.lane.steps.map((s) => s.row));
      for (const end of t.ends) if (end < total && !rows.has(end)) t.lane.steps.push({ row: end, note: null, vel: 100 });
      t.lane.steps.sort((a, b) => a.row - b.row);
      t.lane.fx.sort((a, b) => a.row - b.row);
      if (!t.lane.fx.length) delete t.lane.fx;
      orders.instruments.push(t.inst);
      orders.lanes.push(t.lane);
    }
    parts.push({ seat, orders });
  }
  const merged = { instruments: parts.flatMap((p) => p.orders.instruments), lanes: parts.flatMap((p) => p.orders.lanes) };
  return { bars: rounds.length * cfg.bars, parts, merged };
}
