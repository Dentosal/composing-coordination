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

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}${i}`.slice(0, 32);
    if (!taken.has(id)) return id;
  }
}

/**
 * Keep exactly `maxLanes` lanes whenever there is at least one instrument. New lanes start on the first
 * instrument and stay empty (an empty lane is valid and renders nothing).
 */
export function ensureLanes(orders, maxLanes) {
  if (!orders.instruments.length) return;
  while (orders.lanes.length < maxLanes) orders.lanes.push({ instrument: orders.instruments[0].id, steps: [] });
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
   * @param {{maxInstruments:number,maxLanes:number,getOrders:()=>import('./types.js').Orders,
   *   onChange:()=>void,onStructure?:()=>void,presets:Map<string,any>}} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.o = opts;
    this.pick = 'init';
    this.sel = null; // selected instrument id
    this.collapsed = false; // hide the patch editor to make room for the pattern
    this.aud = new Auditioner({ bpm: opts.bpm ?? 120, seed: opts.seed ?? 1 });
    this.audition = { note: 48, vel: 100, rate: 1 }; // audition settings persist across instruments and edits
    this.render();
  }

  get orders() {
    return this.o.getOrders();
  }

  addPreset(key) {
    const orders = this.orders;
    if (orders.instruments.length >= this.o.maxInstruments) return;
    const p = this.o.presets.get(key);
    if (!p) return;
    const inst = structuredClone(p.instrument);
    inst.id = uniqueId(key, new Set(orders.instruments.map((i) => i.id)));
    orders.instruments.push(inst);
    // Hand the new instrument the first empty lane (lanes are always present, see ensureLanes).
    ensureLanes(orders, this.o.maxLanes);
    const free = orders.lanes.find((l) => l.steps.length === 0);
    if (free) free.instrument = inst.id;
    this.sel = inst.id;
    this.o.onChange();
    this.render();
    this.o.onStructure?.();
  }

  /** Replace the selected instrument's patch with a preset, keeping its id (so lanes stay attached). */
  loadPreset(key) {
    const p = this.o.presets.get(key);
    const i = this.orders.instruments.findIndex((x) => x.id === this.sel);
    if (!p || i < 0) return;
    this.orders.instruments[i] = { ...structuredClone(p.instrument), id: this.sel };
    this.o.onChange();
    this.render();
  }

  remove(id) {
    const orders = this.orders;
    orders.instruments = orders.instruments.filter((i) => i.id !== id);
    orders.lanes = orders.lanes.filter((l) => l.instrument !== id);
    if (this.sel === id) this.sel = orders.instruments[0]?.id ?? null;
    this.o.onChange();
    this.render();
    this.o.onStructure?.();
  }

  destroy() {
    this.aud.stopAll();
  }

  render() {
    const orders = this.orders;
    clear(this.root);
    if (!orders.instruments.some((i) => i.id === this.sel)) this.sel = orders.instruments[0]?.id ?? null;
    if (this.aud.loopId && this.aud.loopId !== this.sel) this.aud.stopLoop(); // the loop belongs to one instrument
    const full = orders.instruments.length >= this.o.maxInstruments;

    const tabs = h('div.inst-tabs');
    for (const inst of orders.instruments) {
      tabs.append(h('div', { class: `inst-tab${inst.id === this.sel ? ' sel' : ''}` },
        h('button.link', { onclick: () => { this.sel = inst.id; this.render(); } }, inst.id),
        h('button.icon', { title: 'Remove instrument', onclick: () => this.remove(inst.id) }, '×')));
    }
    const presetOptions = (cur) => [...this.o.presets].map(([k, p]) =>
      h('option', { value: k, selected: k === cur }, p.label ?? k));
    const addSel = h('select', { onchange: (e) => { this.pick = e.target.value; } }, presetOptions(this.pick));
    tabs.append(h('button.small', { onclick: () => { this.collapsed = !this.collapsed; this.render(); } },
      this.collapsed ? '▸ Show sound editor' : '▾ Hide sound editor'));
    tabs.append(h('div.inst-add', addSel,
      h('button', { disabled: full, onclick: () => this.addPreset(this.pick) },
        full ? `Limit ${this.o.maxInstruments} reached` : '+ Add instrument')));
    this.root.append(tabs);

    const inst = orders.instruments.find((i) => i.id === this.sel);
    if (!inst) {
      this.root.append(h('p.muted', 'No instruments yet. Pick a preset and add one.'));
      return;
    }
    if (!this.collapsed) this.root.append(this.editor(inst));
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

  editor(inst) {
    const idx = () => this.orders.instruments.findIndex((i) => i.id === inst.id); // by id: edits replace the object
    const patch = parseInstrument(inst);

    const loadSel = h('select', presetOptionsFor(this.o.presets));
    const loader = h('div.loader', h('span.muted', 'Start from'), loadSel,
      h('button', { onclick: () => {
        if (confirm(`Replace the sound of "${inst.id}" with the ${loadSel.value} preset?`)) this.loadPreset(loadSel.value);
      } }, 'Load preset'));

    if (!patch) {
      // Not a template instrument (e.g. hand-written orders): only the output levels can be edited here.
      const change = () => this.o.onChange();
      pairDefaults(inst, defaultPatch());
      return h('div.patch', loader, this.auditionBar(inst),
        h('p.muted', 'This instrument has a custom signal graph that this editor cannot show. Load a preset to replace it.'),
        h('div.patch-grid', module('Output',
          knob('level', inst, 'gain', { min: 0, max: 1 }, change),
          knob('delay', inst, 'send_delay', { min: 0, max: 1 }, change),
          knob('reverb', inst, 'send_reverb', { min: 0, max: 1 }, change))));
    }

    // Every edit rebuilds the graph from the patch and swaps it in; lanes refer to the id, which never changes.
    pairDefaults(patch, defaultPatch());
    const routing = h('details.routing', { open: true }, h('summary', 'Signal routing'), routingDiagram(patch));
    const change = () => {
      this.orders.instruments[idx()] = buildInstrument(inst.id, patch);
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

    return h('div.patch', loader, this.auditionBar(inst), routing, h('div.patch-grid',
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
        knob('reverb', patch, 'send_reverb', { min: 0, max: 1 }, change))));
  }
}

function presetOptionsFor(presets) {
  return [...presets].map(([k, p]) => h('option', { value: k }, p.label ?? k));
}
