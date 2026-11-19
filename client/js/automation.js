// Parameter automation in effect cells: which node parameters of an instrument the editor offers, how their values are
// shown and edited, and keeping the cells' entries valid when the instrument changes. The orders format (and the server)
// only know `{node, port, value}`; this module is where those get friendly names, units and slider ranges. It knows the
// synth template's node ids (see synth.js): the filters `lp` and `lp2`, the level gains `l1`..`l3` and `ln`, the LFO
// `lfo` and its depths `lfo_p`/`lfo_c`/`lfo_a`, and the FM gain `fm`.
import { MIDDLE_C_HZ } from './synth.js';
import { MAX_FX_PARAMS } from './fx.js';

/** FM depth is stored as a gain in Hz at middle C (index x modulator frequency); the editor shows the index. */
const fmScale = (inst) => {
  const o = inst.nodes.find((n) => n.id === 'o2');
  if (!o) return 1;
  return o.fixed_hz != null ? o.fixed_hz : MIDDLE_C_HZ * 2 ** ((o.semitones ?? 0) / 12);
};

/**
 * The parameters the editor can automate. `type` is the node type it needs, `port` its parameter; min/max/step/log/unit
 * give the slider (log: exponential, for frequencies); `scale(inst)` converts the shown value to the stored one.
 */
export const PARAMS = [
  { id: 'filter1.cutoff', label: 'Filter 1 cutoff', node: 'lp', type: 'filter', port: 'freq', min: 20, max: 20000, log: true, unit: ' Hz' },
  { id: 'filter1.resonance', label: 'Filter 1 resonance', node: 'lp', type: 'filter', port: 'q', min: 0.1, max: 20, log: true, unit: '' },
  { id: 'filter2.cutoff', label: 'Filter 2 cutoff', node: 'lp2', type: 'filter', port: 'freq', min: 20, max: 20000, log: true, unit: ' Hz' },
  { id: 'filter2.resonance', label: 'Filter 2 resonance', node: 'lp2', type: 'filter', port: 'q', min: 0.1, max: 20, log: true, unit: '' },
  { id: 'osc1.level', label: 'Osc 1 level', node: 'l1', type: 'gain', port: 'gain', min: 0, max: 1, step: 0.01, unit: '' },
  { id: 'osc2.level', label: 'Osc 2 level', node: 'l2', type: 'gain', port: 'gain', min: 0, max: 1, step: 0.01, unit: '' },
  { id: 'osc3.level', label: 'Osc 3 level', node: 'l3', type: 'gain', port: 'gain', min: 0, max: 1, step: 0.01, unit: '' },
  { id: 'noise.level', label: 'Noise level', node: 'ln', type: 'gain', port: 'gain', min: 0, max: 1, step: 0.01, unit: '' },
  { id: 'fm.depth', label: 'FM depth', node: 'fm', type: 'gain', port: 'gain', min: 0, max: 10, step: 0.05, unit: '', scale: fmScale },
  { id: 'lfo.rate', label: 'LFO rate', node: 'lfo', type: 'osc', port: 'freq', min: 0.1, max: 20, log: true, unit: ' Hz', fixedOnly: true },
  { id: 'lfo.pitch', label: 'LFO to pitch', node: 'lfo_p', type: 'gain', port: 'gain', min: 0, max: 200, step: 1, unit: ' ct' },
  { id: 'lfo.cutoff', label: 'LFO to cutoff', node: 'lfo_c', type: 'gain', port: 'gain', min: 0, max: 4000, step: 10, unit: ' Hz' },
  { id: 'lfo.amp', label: 'LFO to volume', node: 'lfo_a', type: 'gain', port: 'gain', min: 0, max: 1, step: 0.01, unit: '' },
];

/** What the server accepts as a parameter entry on `inst` (see `automation_range` in renderer/src/orders.rs). */
export function accepts(inst, entry) {
  const n = inst?.nodes.find((x) => x.id === entry.node);
  if (!n) return false;
  if (n.type === 'osc') return entry.port === 'freq' && n.fixed_hz != null;
  return (n.type === 'gain' && entry.port === 'gain') || (n.type === 'filter' && (entry.port === 'freq' || entry.port === 'q'));
}

const nodeOf = (inst, p) => {
  const n = inst?.nodes.find((x) => x.id === p.node);
  return n && n.type === p.type && (!p.fixedOnly || n.fixed_hz != null) ? n : null;
};

/** The parameters of `inst` the editor offers: those whose node the instrument has. */
export const automatable = (inst) => (inst ? PARAMS.filter((p) => nodeOf(inst, p)) : []);

/** The catalog entry for a cell's `{node, port}` entry on `inst`, or undefined (the instrument has no such parameter). */
export const paramOf = (inst, entry) => automatable(inst).find((p) => p.node === entry.node && p.port === entry.port);

/** The entries of a cell that `inst` can take (the server refuses an entry naming a node the instrument does not have). */
export const usableParams = (inst, params) => (params ?? []).filter((e) => paramOf(inst, e));

const scaleOf = (inst, p) => p.scale?.(inst) ?? 1;
/** The value as the editor shows it (a stored entry value is in the node's units), and back. */
export const toShown = (inst, p, stored) => stored / scaleOf(inst, p);
export const fromShown = (inst, p, shown) => shown * scaleOf(inst, p);

/** The node's own current value, shown: where a new entry starts. */
export function ownValue(inst, p) {
  const n = nodeOf(inst, p);
  const stored = !n ? p.min : p.port === 'q' ? n.q : p.port === 'freq' ? (n.type === 'osc' ? n.fixed_hz : n.freq) : n.gain;
  return clampTo(p, toShown(inst, p, stored));
}

const clampTo = (p, v) => Math.min(p.max, Math.max(p.min, v));

export const SLIDER_STEPS = 1000;
/** Slider position 0..SLIDER_STEPS for a shown value, and back (logarithmic for frequencies; linear values snap to the step). */
export const toPosition = (p, v) => Math.round((p.log ? Math.log(clampTo(p, v) / p.min) / Math.log(p.max / p.min) : (clampTo(p, v) - p.min) / (p.max - p.min)) * SLIDER_STEPS);
export function fromPosition(p, pos) {
  const x = pos / SLIDER_STEPS;
  if (p.log) return Number((p.min * (p.max / p.min) ** x).toPrecision(3));
  const raw = p.min + (p.max - p.min) * x;
  return Number((Math.round(raw / p.step) * p.step).toFixed(6));
}

const fmt = (v) => `${Number(Number(v).toPrecision(3))}`;

/** Words for one entry: "Filter 1 cutoff 1200 Hz". */
export function describeParam(inst, entry) {
  const p = inst && paramOf(inst, entry);
  return p ? `${p.label} ${fmt(toShown(inst, p, entry.value))}${p.unit}` : `${entry.node}.${entry.port} ${fmt(entry.value)}`;
}

/**
 * Drop the entries no instrument can take any more (its graph changed: a filter 2 that is no longer in use is not part of the
 * graph) and the cells that become empty. Returns whether anything changed.
 */
export function pruneParams(orders) {
  let changed = false;
  for (const lane of orders.lanes) {
    if (!lane.fx) continue;
    const inst = orders.instruments.find((i) => i.id === lane.instrument);
    for (const cell of lane.fx) {
      if (!cell.params) continue;
      // Entries outside the editor's catalog are kept (hand-written orders); those the server would refuse are dropped.
      const keep = cell.params.filter((e) => accepts(inst, e));
      if (keep.length === cell.params.length) continue;
      changed = true;
      if (keep.length) cell.params = keep; else delete cell.params;
    }
    const left = lane.fx.filter((c) => Object.keys(c).some((k) => k !== 'row'));
    if (left.length !== lane.fx.length) { lane.fx = left; changed = true; }
    if (!lane.fx.length) delete lane.fx;
  }
  return changed;
}

export { MAX_FX_PARAMS };
