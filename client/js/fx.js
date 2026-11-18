// Effect cells (the lane above each track's notes). Each cell applies during its own row; everything is quantised to
// ticks, ARP_TICKS_PER_ROW to a row (the classic tracker speed):
//   volume  0..1        multiplies the level during the row (rows without one are at 1)
//   arp     {offsets}   the pitch steps through the offsets (semitones), one per tick, restarting at the row's start
//   slide   semitones   the pitch moves by this much over the row (reaching it at the row's last tick) and stays there;
//                       consecutive slide rows add up. Negative slides down.
//   cut     tick 0..5   the note sounding in the row is cut (silenced) at that tick
//   retrig  ticks 1..5  the note restarts every N ticks within the row (a new voice each time; the old one is silenced)
// The plan below mirrors `fx_plan` in server/src/render/voice.rs; both are checked against
// server/tests/fixtures/fx_plan.json.

export const ARP_MAX_OFFSETS = 4;
export const ARP_TICKS_PER_ROW = 6; // the classic tracker speed; not a setting
export const MAX_SLIDE = 24;
export const DEFAULT_ARP = { offsets: [0, 4, 7] };
export const FX_FIELDS = ['volume', 'arp', 'slide', 'cut', 'retrig'];

/**
 * The voices of one note, from its lane's effect cells. Times are seconds after the note's start; the automation
 * times are seconds after the voice's own start.
 * @returns {{start:number, end:number, volumes:[number, number][], pitches:[number, number][]}[]}
 *   volumes: [time, multiplier] on change (a voice ends early, by a cut or a retrigger, with a final 0 so it is silent
 *   from that instant); pitches: [time, semitones] on change (slide + arpeggio; the voice starts at 0).
 */
export function notePlan(fx, startRow, endRow, rowSecs) {
  const tpr = ARP_TICKS_PER_ROW;
  const tick = rowSecs / tpr;
  const nTicks = (endRow - startRow) * tpr;
  const naturalEnd = (endRow - startRow) * rowSecs;
  if (!fx?.length) return [{ start: 0, end: naturalEnd, volumes: [], pitches: [] }];
  const byRow = new Map(fx.map((f) => [f.row, f]));
  const vol = [];
  const pitch = [];
  let accum = 0;
  let cut = null;
  const retrig = [];
  for (let r = startRow; r < endRow; r++) {
    const f = byRow.get(r);
    const slide = f?.slide ?? 0;
    const offsets = f?.arp?.offsets?.length ? f.arp.offsets : null;
    for (let k = 0; k < tpr; k++) {
      vol.push(f?.volume ?? 1);
      const off = offsets ? offsets[k % offsets.length] : 0;
      pitch.push(accum + (slide * (k + 1)) / tpr + off);
    }
    accum += slide;
    const base = (r - startRow) * tpr;
    if (cut === null && f?.cut !== undefined) cut = base + f.cut;
    if (f?.retrig !== undefined) for (let k = f.retrig; k < tpr; k += f.retrig) retrig.push(base + k);
  }
  const end = cut === null ? nTicks : Math.min(cut, nTicks);
  const bounds = [0, ...retrig.sort((a, b) => a - b).filter((t) => t > 0 && t < end)];
  const segs = [];
  bounds.forEach((s, j) => {
    const e = j + 1 < bounds.length ? bounds[j + 1] : end;
    if (e <= s) return;
    let vl = 1;
    let pl = 0;
    const volumes = [];
    const pitches = [];
    for (let i = s; i < e; i++) {
      const t = (i - s) * tick;
      if (vol[i] !== vl) { volumes.push([t, vol[i]]); vl = vol[i]; }
      if (pitch[i] !== pl) { pitches.push([t, pitch[i]]); pl = pitch[i]; }
    }
    const natural = e === nTicks;
    if (!natural) volumes.push([(e - s) * tick, 0]);
    segs.push({ start: s * tick, end: natural ? naturalEnd : e * tick, volumes, pitches });
  });
  return segs;
}

/** The effect cell at `row`, or undefined. */
export const fxAt = (lane, row) => lane.fx?.find((f) => f.row === row);

/**
 * Set (or, with `null`, remove) one effect field of the cell at `row`; the cell disappears when nothing is left in it.
 * @param {'volume'|'arp'|'slide'|'cut'|'retrig'} field
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
  if (cell && FX_FIELDS.every((k) => cell[k] === undefined)) lane.fx = lane.fx.filter((f) => f !== cell);
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

/** One letter per effect in the cell: V volume, A arpeggio, S slide, C cut, R retrigger (the values are in the hover text). */
export function fxLabel(cell) {
  return (cell.volume !== undefined ? 'V' : '') + (cell.arp ? 'A' : '') + (cell.slide !== undefined ? 'S' : '')
    + (cell.cut !== undefined ? 'C' : '') + (cell.retrig !== undefined ? 'R' : '');
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));

/** Hover text describing a cell. */
export function fxTitle(cell) {
  const parts = [];
  if (cell.volume !== undefined) parts.push(`volume ${Math.round(cell.volume * 100)}%`);
  if (cell.arp) parts.push(`arpeggio ${cell.arp.offsets.map(signed).join(' ')}`);
  if (cell.slide !== undefined) parts.push(`slide ${signed(cell.slide)} semitones per row`);
  if (cell.cut !== undefined) parts.push(`cut at tick ${cell.cut}`);
  if (cell.retrig !== undefined) parts.push(`retrigger every ${cell.retrig} tick${cell.retrig === 1 ? '' : 's'}`);
  return parts.join(', ');
}
