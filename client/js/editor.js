// Instrument panel: a tab per instrument, and a fixed-architecture synth patch editor (see synth.js).
import { h, clear } from './dom.js';
import { Auditioner } from './audition.js';
import { routingDiagram } from './routing.js';
import { FILTER_MODES, WAVES, buildInstrument, defaultPatch, parseInstrument } from './synth.js';

let presetCache = null;

export async function loadPresets() {
  if (presetCache) return presetCache;
  const names = await (await fetch('presets/index.json')).json();
  const entries = await Promise.all(
    names.map(async (n) => [n, await (await fetch(`presets/${n}.json`)).json()]),
  );
  presetCache = new Map(entries);
  return presetCache;
}

/**
 * Normalise orders to exactly `n` tracks: track i = lanes[i] + the instrument it names (one-to-one). Orphans and
 * duplicates are dropped, missing tracks get a copy of the init preset and an empty lane.
 */
export function ensureTracks(orders, n, presets) {
  const byId = new Map(orders.instruments.map((i) => [i.id, i]));
  const instruments = [];
  const lanes = [];
  for (const lane of orders.lanes) {
    const inst = byId.get(lane.instrument);
    if (!inst || lanes.length >= n) continue;
    byId.delete(lane.instrument); // a second lane on the same instrument is dropped
    instruments.push(inst);
    lanes.push(lane);
  }
  const taken = new Set(instruments.map((i) => i.id));
  for (let k = 1; lanes.length < n; k++) {
    const id = `track${k}`;
    if (taken.has(id)) continue;
    taken.add(id);
    const base = presets.get('init')?.instrument;
    instruments.push({ ...structuredClone(base), id, name: presets.get('init')?.label ?? 'Init' });
    lanes.push({ instrument: id, steps: [] });
  }
  orders.instruments = instruments;
  orders.lanes = lanes;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteLabel = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

/** Loop rates as multiples of the session BPM (1x = one note per beat). */
const LOOP_RATES = [
  [0.25, '¼× (once a bar)'], [0.5, '½× (half notes)'], [1, '1× (quarter notes)'],
  [2, '2× (eighth notes)'], [4, '4× (sixteenth notes)'], [8, '8× (thirty-second notes)'],
];

const fmt = (v) => `${Number(Number(v).toPrecision(3))}`;

/** patch sub-object -> the matching sub-object of the default patch, so a slider can find its default. */
const DEFAULTS = new WeakMap();
function pairDefaults(obj, def) {
  DEFAULTS.set(obj, def);
  for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object' && def?.[k]) pairDefaults(v, def[k]);
}

/**
 * A labelled slider with a value readout. `o.log` maps the slider exponentially between min and max
 * (for Hz and seconds). Writes `obj[key]` and calls `change` on every input. Double-click resets it to the
 * default patch's value (or `o.def` where the default is not a number).
 */
function knob(label, obj, key, o, change) {
  const { min, max, step = 0.01, log = false, unit = '' } = o;
  const toSlider = (v) => (log ? Math.log(Math.max(v, min) / min) / Math.log(max / min) : v);
  const fromSlider = (x) => {
    if (!log) return x;
    const v = min * (max / min) ** x;
    return Number(v.toPrecision(3));
  };
  const out = h('output', fmt(obj[key]) + unit);
  const input = h('input', {
    title: 'Double-click to reset',
    type: 'range', min: log ? '0' : String(min), max: log ? '1' : String(max), step: log ? '0.001' : String(step),
    value: String(toSlider(obj[key])),
    oninput: (e) => {
      obj[key] = fromSlider(parseFloat(e.target.value));
      out.textContent = fmt(obj[key]) + unit;
      change();
    },
    ondblclick: () => {
      const def = o.def ?? DEFAULTS.get(obj)?.[key];
      if (typeof def !== 'number') return;
      obj[key] = def;
      input.value = String(toSlider(def));
      out.textContent = fmt(def) + unit;
      change();
    },
  });
  return h('label.knob', h('span', label), input, out);
}

function select(label, obj, key, options, change) {
  return h('label.knob', h('span', label),
    h('select', { onchange: (e) => { obj[key] = e.target.value; change(); } },
      options.map((v) => h('option', { value: v, selected: v === obj[key] }, v))));
}

const check = (label, get, set) =>
  h('label.check', h('input', { type: 'checkbox', checked: get(), onchange: (e) => set(e.target.checked) }), label);

const module = (title, ...kids) => h('section.module', h('h4', title), ...kids);

export class InstrumentPanel {
  /**
   * @param {HTMLElement} root
   * @param {{getOrders:()=>import('./types.js').Orders,
   *   onChange:()=>void,getActive:()=>number,presets:Map<string,any>}} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.o = opts;
    this.pick = 'init'; // preset chosen in the overwrite selector
    this.nodesOpen = true; // node configuration section (collapse to make room for the pattern)
    this.routingOpen = false; // signal routing diagram, collapsed by default
    this.aud = new Auditioner({ bpm: opts.bpm ?? 120, seed: opts.seed ?? 1 });
    this.audition = { note: 48, vel: 100, rate: 1 }; // audition settings persist across instruments and edits
    this.render();
  }

  get orders() {
    return this.o.getOrders();
  }

  /** The instrument of the active track (the pattern's current column). */
  get active() {
    const lane = this.orders.lanes[this.o.getActive()];
    return this.orders.instruments.find((i) => i.id === lane?.instrument) ?? null;
  }

  /** Overwrite the active track's patch with a preset, keeping its id (so the lane stays attached). */
  loadPreset(key) {
    const p = this.o.presets.get(key);
    const cur = this.active;
    if (!p || !cur) return;
    const i = this.orders.instruments.indexOf(cur);
    this.orders.instruments[i] = { ...structuredClone(p.instrument), id: cur.id, name: p.label ?? key };
    this.o.onRename?.();
    this.o.onChange();
    this.render();
  }

  destroy() {
    this.aud.stopAll();
  }

  render() {
    clear(this.root);
    const inst = this.active;
    if (this.aud.loopId && this.aud.loopId !== inst?.id) this.aud.stopLoop(); // the loop belongs to one instrument
    if (!inst) {
      this.root.append(h('p.muted', 'No track selected.'));
      return;
    }
    this.root.append(this.editor(inst));
  }

  /** Note picker, velocity, and three ways to play it: once, held while pressed, or looped at a BPM multiple. */
  auditionBar(inst) {
    const st = this.audition;
    const current = () => this.orders.instruments.find((i) => i.id === inst.id);
    const noteSel = h('select', { title: 'Note to play', onchange: (e) => { st.note = Number(e.target.value); } },
      Array.from({ length: 73 }, (_, i) => i + 24).map((m) =>
        h('option', { value: m, selected: m === st.note }, noteLabel(m))));
    const vel = h('input', { type: 'range', min: '1', max: '127', value: String(st.vel), title: 'Velocity',
      oninput: (e) => { st.vel = Number(e.target.value); velOut.textContent = String(st.vel); } });
    const velOut = h('output', String(st.vel));
    const rateSel = h('select', { title: 'Repeat rate, as a multiple of the session BPM',
      onchange: (e) => { st.rate = Number(e.target.value); } },
      LOOP_RATES.map(([v, label]) => h('option', { value: v, selected: v === st.rate }, label)));

    // Hold: sounds while the pointer (or Space/Enter) is down; released on up, leave or cancel.
    let held = null;
    let wantHold = false;
    const holdBtn = h('button.hold', { title: 'Hold to sustain the note' }, '● Hold');
    const press = async () => {
      if (wantHold) return;
      wantHold = true;
      holdBtn.classList.add('on');
      const handle = await this.aud.hold(current(), st.note, st.vel);
      if (wantHold) held = handle;
      else handle.release();
    };
    const lift = () => {
      wantHold = false;
      holdBtn.classList.remove('on');
      held?.release();
      held = null;
    };
    holdBtn.addEventListener('pointerdown', (e) => { holdBtn.setPointerCapture(e.pointerId); press(); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) holdBtn.addEventListener(ev, lift);
    holdBtn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } });
    holdBtn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') lift(); });

    const looping = () => this.aud.loopId === inst.id;
    const loopBtn = h('button', { onclick: async () => {
      if (looping()) this.aud.stopLoop();
      else await this.aud.startLoop(inst.id, () => ({ inst: current(), note: st.note, vel: st.vel, mult: st.rate }));
      sync();
    } });
    const sync = () => {
      loopBtn.textContent = looping() ? '■ Stop loop' : '↻ Loop';
      loopBtn.classList.toggle('on', looping());
    };
    sync();

    return h('div.audition',
      h('strong', 'Audition'),
      h('label', 'note', noteSel),
      h('label', 'velocity', vel, velOut),
      h('button', { onclick: () => this.aud.once(current(), st.note, st.vel) }, '▶ Once'),
      holdBtn,
      h('span.loop', loopBtn, h('label', 'rate', rateSel)));
  }

  /** A collapsible section whose open state survives re-renders. */
  section(cls, title, key, ...kids) {
    const d = h(`details.${cls}`, { open: this[key] }, h('summary', title), ...kids);
    d.addEventListener('toggle', () => { this[key] = d.open; });
    return d;
  }

  editor(inst) {
    const idx = () => this.orders.instruments.findIndex((i) => i.id === inst.id); // by id: edits replace the object
    const patch = parseInstrument(inst);

    const loadSel = h('select', presetOptionsFor(this.o.presets));
    const nameIn = h('input.track-name', { value: inst.name ?? inst.id, maxlength: '32', placeholder: 'Track name', 'aria-label': 'Track name',
      oninput: (e) => {
        const cur = this.orders.instruments[idx()];
        cur.name = e.target.value;
        this.o.onChange();
        this.o.onRename?.();
      } });
    const loader = h('div.loader', h('span.muted', 'Preset'), loadSel,
      h('button', { onclick: () => {
        if (confirm(`Overwrite the patch of track ${this.o.getActive() + 1} with the ${loadSel.value} preset?`)) this.loadPreset(loadSel.value);
      } }, 'Overwrite patch'));
    const head = h('div.track-head', h('strong', `Track ${this.o.getActive() + 1}`), nameIn, loader);

    if (!patch) {
      // Not a template instrument (e.g. hand-written orders): only the output levels can be edited here.
      const change = () => this.o.onChange();
      pairDefaults(inst, defaultPatch());
      return h('div.patch', head, this.auditionBar(inst),
        h('p.muted', 'This instrument has a custom signal graph that this editor cannot show. Overwrite it from a preset to edit it here.'),
        this.section('nodes', 'Node configuration', 'nodesOpen', h('div.patch-grid', module('Output',
          knob('level', inst, 'gain', { min: 0, max: 1 }, change),
          knob('delay', inst, 'send_delay', { min: 0, max: 1 }, change),
          knob('reverb', inst, 'send_reverb', { min: 0, max: 1 }, change)))));
    }

    // Every edit rebuilds the graph from the patch and swaps it in; lanes refer to the id, which never changes.
    pairDefaults(patch, defaultPatch());
    const routing = this.section('routing', 'Signal routing', 'routingOpen', routingDiagram(patch));
    const change = () => {
      this.orders.instruments[idx()] = buildInstrument(inst.id, patch, this.orders.instruments[idx()].name);
      routing.lastElementChild.replaceWith(routingDiagram(patch));
      this.o.onChange();
    };
    const oscRow = (o, n) => h('div.osc',
      h('div.osc-head', h('strong', `Osc ${n}`), select('', o, 'wave', WAVES, change)),
      knob('level', o, 'level', { min: 0, max: 1 }, change),
      o.fixed_hz == null
        ? knob('pitch', o, 'semitones', { min: -48, max: 48, step: 1, unit: ' st' }, change)
        : knob('pitch', o, 'fixed_hz', { min: 20, max: 2000, log: true, unit: ' Hz', def: 220 }, change),
      knob('fine', o, 'detune', { min: -100, max: 100, step: 1, unit: ' ct' }, change),
      h('div.osc-opts',
        check('fixed pitch', () => o.fixed_hz != null, (on) => {
          o.fixed_hz = on ? 220 : null;
          change();
          this.render();
        }),
        check('through filter', () => o.filtered, (on) => { o.filtered = on; change(); })));
    const noise = patch.noise;
    const adsr = (title, e, amount) => module(title,
      knob('attack', e, 'attack', { min: 0.001, max: 5, log: true, unit: ' s' }, change),
      knob('decay', e, 'decay', { min: 0.001, max: 5, log: true, unit: ' s' }, change),
      knob('sustain', e, 'sustain', { min: 0, max: 1 }, change),
      knob('release', e, 'release', { min: 0.001, max: 5, log: true, unit: ' s' }, change),
      amount ? knob(amount.label, e, 'amount', amount, change) : null);

    return h('div.patch', head, this.auditionBar(inst), this.section('nodes', 'Node configuration', 'nodesOpen', h('div.patch-grid',
      module('Oscillators', patch.osc.map((o, i) => oscRow(o, i + 1))),
      module('Noise',
        select('color', noise, 'color', ['white', 'pink'], change),
        knob('level', noise, 'level', { min: 0, max: 1 }, change),
        check('through filter', () => noise.filtered, (on) => { noise.filtered = on; change(); })),
      module('Filter',
        select('type', patch.filter, 'mode', FILTER_MODES, change),
        knob('cutoff', patch.filter, 'freq', { min: 20, max: 20000, log: true, unit: ' Hz' }, change),
        knob('resonance', patch.filter, 'q', { min: 0.1, max: 20, log: true }, change),
        knob('key track', patch.filter, 'key_track', { min: 0, max: 1 }, change),
        knob('drive', patch, 'drive', { min: 0, max: 20, step: 0.5 }, change)),
      adsr('Amp envelope', patch.aenv),
      adsr('Filter envelope', patch.fenv, { label: 'amount', min: -8000, max: 8000, step: 10, unit: ' Hz' }),
      adsr('Pitch envelope', patch.penv, { label: 'amount', min: -4800, max: 4800, step: 10, unit: ' ct' }),
      module('LFO',
        select('wave', patch.lfo, 'wave', WAVES, change),
        knob('rate', patch.lfo, 'rate', { min: 0.1, max: 20, log: true, unit: ' Hz' }, change),
        knob('→ pitch', patch.lfo, 'pitch', { min: 0, max: 200, step: 1, unit: ' ct' }, change),
        knob('→ cutoff', patch.lfo, 'cutoff', { min: 0, max: 4000, step: 10, unit: ' Hz' }, change),
        knob('→ volume', patch.lfo, 'amp', { min: 0, max: 1 }, change)),
      module('Output',
        knob('level', patch, 'gain', { min: 0, max: 1 }, change),
        knob('delay', patch, 'send_delay', { min: 0, max: 1 }, change),
        knob('reverb', patch, 'send_reverb', { min: 0, max: 1 }, change)))), routing);
  }
}

function presetOptionsFor(presets) {
  return [...presets].map(([k, p]) => h('option', { value: k }, p.label ?? k));
}
