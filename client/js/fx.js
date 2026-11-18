// Effect cells (the lane above each track's notes). Each cell applies during its own row only:
//   volume  0..1   multiplies the notes' level during the row (rows without a volume are at 1)
//   arp     {offsets}   substep arpeggio: the pitch cycles through the offsets (semitones), once per tick, with
//                       ARP_TICKS_PER_ROW ticks in every row, restarting at the start of the row
// The plan below mirrors `fx_plan` in server/src/render/voice.rs; both are checked against
// server/tests/fixtures/fx_plan.json.

export const ARP_MAX_OFFSETS = 4;
export const ARP_TICKS_PER_ROW = 6; // the classic tracker speed; not a setting
export const DEFAULT_ARP = { offsets: [0, 4, 7] };

/**
 * Parameter automation for one note from its lane's effect cells. Times are seconds after the note's start.
 * @param {{row:number, volume?:number, arp?:{offsets:number[]}}[]} fx
 * @returns {{volumes:[number, number][], pitches:[number, number][]}}
 */
export function notePlan(fx, startRow, endRow, rowSecs) {
  const plan = { volumes: [], pitches: [] };
  if (!fx?.length) return plan;
  const byRow = new Map(fx.map((f) => [f.row, f]));
  let lastVol = 1;
  let arpOn = false;
  for (let r = startRow; r < endRow; r++) {
    const t = (r - startRow) * rowSecs;
    const f = byRow.get(r);
    const vol = f?.volume ?? 1;
    if (vol !== lastVol) {
      plan.volumes.push([t, vol]);
      lastVol = vol;
    }
    const a = f?.arp;
    if (a && a.offsets.length) {
      for (let k = 0; k < ARP_TICKS_PER_ROW; k++) plan.pitches.push([t + (k * rowSecs) / ARP_TICKS_PER_ROW, a.offsets[k % a.offsets.length]]);
      arpOn = true;
    } else if (arpOn) {
      plan.pitches.push([t, 0]);
      arpOn = false;
    }
  }
  return plan;
}

/** The effect cell at `row`, or undefined. */
export const fxAt = (lane, row) => lane.fx?.find((f) => f.row === row);

/**
 * Set (or, with `null`, remove) one effect field of the cell at `row`; the cell disappears when nothing is left in it.
 * @param {'volume'|'arp'} field
 */
export function setFxField(lane, row, field, value) {
  if (value == null && !lane.fx) return;
  lane.fx ??= [];
  let cell = lane.fx.find((f) => f.row === row);
  if (value == null) {
    if (!cell) return;
    delete cell[field];
  } else {
    if (!cell) {
      cell = { row };
      lane.fx.push(cell);
    }
    cell[field] = structuredClone(value);
  }
  if (cell && cell.volume === undefined && cell.arp === undefined) lane.fx = lane.fx.filter((f) => f !== cell);
  lane.fx.sort((a, b) => a.row - b.row);
  if (!lane.fx.length) delete lane.fx;
}

/** Remove every effect from the cells of `rows` (an array of row numbers). */
export function clearFx(lane, rows) {
  if (!lane.fx) return;
  const set = new Set(rows);
  lane.fx = lane.fx.filter((f) => !set.has(f.row));
  if (!lane.fx.length) delete lane.fx;
}

/** One letter per effect in the cell: "V" volume, "A" arpeggio, "VA" both (the values are in the hover text). */
export function fxLabel(cell) {
  return (cell.volume !== undefined ? 'V' : '') + (cell.arp ? 'A' : '');
}

/** Hover text describing a cell. */
export function fxTitle(cell) {
  const parts = [];
  if (cell.volume !== undefined) parts.push(`volume ${Math.round(cell.volume * 100)}%`);
  if (cell.arp) parts.push(`arpeggio ${cell.arp.offsets.map((o) => (o > 0 ? `+${o}` : String(o))).join(' ')}`);
  return parts.join(', ');
}
