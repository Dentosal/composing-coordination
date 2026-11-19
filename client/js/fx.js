// Effect cells (the lane above each track's notes). Each cell applies during its own row; everything is quantised to
// ticks, ARP_TICKS_PER_ROW to a row (the classic tracker speed):
//   volume  0..1        multiplies the level during the row (rows without one are at 1)
//   arp     {offsets}   the pitch steps through the offsets (semitones), one per tick, restarting at the row's start
//   slide   semitones   the pitch moves by this much over the row (reaching it at the row's last tick) and stays there;
//                       consecutive slide rows add up. Negative slides down.
//   cut     tick 0..5   the note sounding in the row is cut (silenced) at that tick
//   retrig  ticks 1..5  the note restarts every N ticks within the row (a new voice each time; the old one is silenced)
//   params  [{node, port, value, glide?}]  up to MAX_FX_PARAMS automated node parameters (the instrument's filter cutoff,
//                       resonance, a gain, ...): each takes `value` during the row, in the node's units at middle C (scaled by
//                       the note's pitch like the node's own value). Rows without an entry for it are back at the node's own
//                       value at once; the loop starts there too. `glide`: move there over the row from where the row before
//                       left off (exponentially for frequencies).
// The plan below mirrors `fx_plan` in renderer/src/render/voice.rs; both are checked against
// server/tests/fixtures/fx_plan.json.

export const ARP_MAX_OFFSETS = 4;
export const ARP_TICKS_PER_ROW = 6; // the classic tracker speed; not a setting
export const MAX_SLIDE = 24;
export const DEFAULT_ARP = { offsets: [0, 4, 7] };
export const MAX_FX_PARAMS = 3;
export const FX_FIELDS = ['volume', 'arp', 'slide', 'cut', 'retrig', 'params'];
const MIDDLE_C_HZ = 261.6255653005986;

/**
 * How an automatable parameter of `inst` behaves for a note at `hz`, or null (the instrument has no such parameter, or it
 * cannot be automated): `base` is its own value for this note (a filter cutoff includes its key tracking), `factor` what a
 * cell's value is multiplied by, `exp` whether it glides exponentially (frequencies), `lo`/`hi` the range it is held to.
 * Must stay identical to `param_target` in renderer/src/render/voice.rs.
 */
export function paramTarget(inst, hz, node, port) {
  const n = inst.nodes.find((x) => x.id === node);
  if (!n) return null;
  const tracked = (keyTrack) => (hz / MIDDLE_C_HZ) ** (keyTrack ?? 0);
  if (n.type === 'gain' && port === 'gain') {
    const f = tracked(n.key_track);
    return { base: n.gain * f, factor: f, exp: false, lo: -1e9, hi: 1e9 };
  }
  if (n.type === 'filter' && port === 'freq') {
    const f = tracked(n.key_track);
    return { base: Math.min(22000, Math.max(10, n.freq * f)), factor: f, exp: true, lo: 10, hi: 22000 };
  }
  if (n.type === 'filter' && port === 'q') return { base: n.q, factor: 1, exp: false, lo: 0.0001, hi: 30 };
  if (n.type === 'osc' && n.fixed_hz != null && port === 'freq') return { base: n.fixed_hz, factor: 1, exp: true, lo: 0.01, hi: 20000 };
  return null;
}

const glideValue = (a, b, f, exp) => (exp && a > 0 && b > 0 ? a * (b / a) ** f : a + (b - a) * f);

/** One automated parameter over a note's rows (mirrors `ParamLine` in voice.rs): per-row start/end values and the changes along the note. */
function paramLine(node, port, target, byRow, startRow, endRow) {
  const tpr = ARP_TICKS_PER_ROW;
  const entry = (r) => byRow.get(r)?.params?.find((p) => p.node === node && p.port === port);
  const endValue = (r) => {
    const e = entry(r);
    return e ? Math.min(target.hi, Math.max(target.lo, e.value * target.factor)) : target.base;
  };
  const rows = []; // [value at the row's start, value at its end, glides]
  for (let r = startRow; r < endRow; r++) {
    const ve = endValue(r);
    const glide = !!entry(r)?.glide;
    // A glide starts from where the row before left off, even if the note itself starts on this row.
    const vs = glide ? (r === 0 ? target.base : endValue(r - 1)) : ve;
    rows.push([vs, ve, glide && vs !== ve]);
  }
  const events = []; // [tick, value, ramp]: a glide row has a step at its start (the ramp's start) and a ramp at its end
  let cur = rows.length ? rows[0][0] : target.base;
  rows.forEach(([vs, ve, glide], i) => {
    if (glide) events.push([i * tpr, vs, false], [(i + 1) * tpr, ve, true]);
    else if (ve !== cur) events.push([i * tpr, ve, false]);
    cur = ve;
  });
  return {
    node, port, target, events,
    /** The value at the start of tick `tick` of the note (inside a glide row: partway along the glide). */
    valueAtTick(tick) {
      const i = Math.min(Math.floor(tick / tpr), rows.length - 1);
      const [vs, ve, glide] = rows[i];
      return glide ? glideValue(vs, ve, Math.min((tick - i * tpr) / tpr, 1), target.exp) : ve;
    },
  };
}

/**
 * The voices of one note, from its lane's effect cells. Times are seconds after the note's start; the automation
 * times are seconds after the voice's own start.
 * `target(node, port)` describes the instrument's automatable parameters (see `paramTarget`; null: it has none).
 * @returns {{start:number, end:number, volumes:[number, number][], pitches:[number, number][],
 *   params:{node:string, port:string, exp:boolean, initial:number, events:[number, number, boolean][]}[]}[]}
 *   volumes: [time, multiplier] on change (a voice ends early, by a cut or a retrigger, with a final 0 so it is silent
 *   from that instant); pitches: [time, semitones] on change (slide + arpeggio; the voice starts at 0);
 *   params: each automated parameter with its value at the voice's start and its changes [time, value, ramp] (a ramp
 *   moves there from the previous event, the voice's start counting as one), only if it differs from the node's own value.
 */
export function notePlan(fx, startRow, endRow, rowSecs, target = () => null) {
  const tpr = ARP_TICKS_PER_ROW;
  const tick = rowSecs / tpr;
  const nTicks = (endRow - startRow) * tpr;
  const naturalEnd = (endRow - startRow) * rowSecs;
  if (!fx?.length) return [{ start: 0, end: naturalEnd, volumes: [], pitches: [], params: [] }];
  const byRow = new Map(fx.map((f) => [f.row, f]));
  // The automated parameters of the note: those with an entry in one of its rows (that the instrument has).
  const lines = [];
  for (let r = startRow; r < endRow; r++) {
    for (const ps of byRow.get(r)?.params ?? []) {
      if (lines.some((l) => l.node === ps.node && l.port === ps.port)) continue;
      const t = target(ps.node, ps.port);
      if (t) lines.push(paramLine(ps.node, ps.port, t, byRow, startRow, endRow));
    }
  }
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
    // Each automated parameter, as it goes in this voice: its value at the voice's start, then the changes inside it.
    const params = [];
    for (const l of lines) {
      const initial = l.valueAtTick(s);
      const events = l.events.filter(([t, , ramp]) => t > s && (ramp ? t <= e : t < e)).map(([t, value, ramp]) => [(t - s) * tick, value, ramp]);
      // A voice that ends partway through a glide row (a cut or a retrigger) still glides as far as it gets.
      if (l.events.some(([t, , ramp]) => ramp && t > e && t - tpr < e)) events.push([(e - s) * tick, l.valueAtTick(e), true]);
      if (initial !== l.target.base || events.length) params.push({ node: l.node, port: l.port, exp: l.target.exp, initial, events });
    }
    segs.push({ start: s * tick, end: natural ? naturalEnd : e * tick, volumes, pitches, params });
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
  if (field === 'params' && !value?.length) value = null; // no entries is no field
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

/** One letter per effect in the cell: V volume, A arpeggio, S slide, C cut, R retrigger, P parameters (the values are in the hover text). */
export function fxLabel(cell) {
  return (cell.volume !== undefined ? 'V' : '') + (cell.arp ? 'A' : '') + (cell.slide !== undefined ? 'S' : '')
    + (cell.cut !== undefined ? 'C' : '') + (cell.retrig !== undefined ? 'R' : '') + (cell.params?.length ? 'P' : '');
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * Hover text describing a cell. `describeParam(entry)` words one parameter entry (the editor knows the parameter's name
 * and unit); without it the node and port are shown.
 */
export function fxTitle(cell, describeParam = (e) => `${e.node}.${e.port} ${e.value}`) {
  const parts = [];
  if (cell.volume !== undefined) parts.push(`volume ${Math.round(cell.volume * 100)}%`);
  if (cell.arp) parts.push(`arpeggio ${cell.arp.offsets.map(signed).join(' ')}`);
  if (cell.slide !== undefined) parts.push(`slide ${signed(cell.slide)} semitones per row`);
  if (cell.cut !== undefined) parts.push(`cut at tick ${cell.cut}`);
  if (cell.retrig !== undefined) parts.push(`retrigger every ${cell.retrig} tick${cell.retrig === 1 ? '' : 's'}`);
  for (const e of cell.params ?? []) parts.push(`${describeParam(e)}${e.glide ? ' (glide)' : ''}`);
  return parts.join(', ');
}
