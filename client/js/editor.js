// Instrument panel: a tab per instrument, and a fixed-architecture synth patch editor (see synth.js).
import { h, clear } from './dom.js';
import { Auditioner } from './audition.js';
import { adsrControl } from './adsr.js';
import { routingDiagram } from './routing.js';
import { FILTER_MODES, WAVES, buildInstrument, defaultPatch, isDefaultPatch, parseInstrument } from './synth.js';

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
 * A labelled slider with an editable value field. `o.log` maps the slider exponentially between min and max
 * (for Hz and seconds). Writes `obj[key]` and calls `change` on every edit, from either control: dragging the
 * slider updates the field, and typing a number (units optional) moves the slider. Typed values are clamped to
 * the range (the unit is displayed next to the field, outside the editable text); Enter or leaving the field tidies the text, Escape restores the value from when the field was entered, ArrowUp/Down nudge by a step
 * (Shift: ten steps). Double-click the slider to reset it to the default patch's value (or `o.def`).
 */
function knob(label, obj, key, o, change) {
  const { min, max, step = 0.01, log = false, unit = '' } = o;
  const toSlider = (v) => (log ? Math.log(Math.max(v, min) / min) / Math.log(max / min) : v);
  const fromSlider = (x) => {
    if (!log) return x;
    const v = min * (max / min) ** x;
    return Number(v.toPrecision(3));
  };
  /** Clamp to the range and snap to the step (linear knobs) or three significant digits (log knobs). */
  const normalize = (v) => {
    const c = Math.min(max, Math.max(min, v));
    return log ? Number(c.toPrecision(3)) : Number((Math.round(c / step) * step).toFixed(6));
  };
  const text = (v) => fmt(v); // the unit is shown beside the field, not inside it
  const field = h('input.val', { type: 'text', inputmode: 'decimal', value: text(obj[key]), spellcheck: 'false',
    title: 'Type a value, or use ↑ ↓ (Shift: ×10)', 'aria-label': label });
  const slider = h('input', {
    title: 'Double-click to reset',
    type: 'range', min: log ? '0' : String(min), max: log ? '1' : String(max), step: log ? '0.001' : String(step),
    value: String(toSlider(obj[key])),
    oninput: (e) => {
      obj[key] = fromSlider(parseFloat(e.target.value));
      field.value = text(obj[key]);
      change();
    },
    ondblclick: () => {
      const def = o.def ?? DEFAULTS.get(obj)?.[key];
      if (typeof def !== 'number') return;
      obj[key] = def;
      slider.value = String(toSlider(def));
      field.value = text(def);
      change();
    },
  });
  const apply = (v) => {
    obj[key] = v;
    slider.value = String(toSlider(v));
    change();
  };
  // Typing applies as soon as the text is a number, without rewriting what the user is typing.
  field.addEventListener('input', () => {
    const v = parseFloat(field.value.replace(',', '.'));
    if (Number.isFinite(v)) apply(normalize(v));
  });
  const tidy = () => { field.value = text(obj[key]); };
  field.addEventListener('change', tidy);
  field.addEventListener('blur', tidy);
  let before = obj[key]; // value when the field was entered, for Escape
  field.addEventListener('focus', () => { before = obj[key]; field.select(); });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { tidy(); field.blur(); return; }
    if (e.key === 'Escape') { if (obj[key] !== before) apply(before); tidy(); field.blur(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    const mult = e.shiftKey ? 10 : 1;
    const cur = obj[key];
    // Log knobs move proportionally (about a semitone per step); linear knobs by their slider step.
    const next = log ? cur * (1.06 ** (dir * mult)) : cur + dir * step * mult;
    apply(normalize(next));
    tidy();
    field.select();
  });
  return h('label.knob', h('span', label), slider, h('span.val-wrap', field, unit ? h('span.unit', unit.trim()) : null));
}

function select(label, obj, key, options, change) {
  return h('label.knob', h('span', label),
    h('select', { onchange: (e) => { obj[key] = e.target.value; change(); } },
      options.map((v) => h('option', { value: v, selected: v === obj[key] }, v))));
}

const check = (label, get, set) =>
  h('label.check', h('input', { type: 'checkbox', checked: get(), onchange: (e) => set(e.target.checked) }), label);

const module = (title, ...kids) => h('section.module', title ? h('h4', title) : null, ...kids);
/** Tag an element with the routing-diagram node it corresponds to (see InstrumentPanel.linkHighlight). */
const node = (key, el) => { el.dataset.node = key; return el; };

export class InstrumentPanel {
  /**
   * @param {HTMLElement} root
   * @param {{getOrders:()=>import('./types.js').Orders,
   *   onChange:()=>void,getActive:()=>number,presets:Map<string,any>}} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.o = opts;
    this.oscTab = 0; // which oscillator is shown in the Oscillators box
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
    this.hlKey = null;
    this.hlDiagramOnly = false;
    this.root.append(this.editor(inst));
    this.linkHighlight();
  }

  /**
   * Highlight every element tagged `data-node=key` (config boxes and diagram boxes alike); null clears.
   * `diagramOnly` limits it to the routing diagram (used by the oscillator tabs: they point at the diagram box,
   * not at the config box they are part of).
   */
  highlight(key, diagramOnly = false) {
    this.hlKey = key;
    this.hlDiagramOnly = diagramOnly;
    for (const el of this.root.querySelectorAll('.hl')) el.classList.remove('hl');
    if (!key) return;
    for (const el of this.root.querySelectorAll(`[data-node="${key}"]`)) {
      if (!diagramOnly || el instanceof SVGElement) el.classList.add('hl');
    }
  }

  /** Two-way link: hovering or focusing either a node-config box or a routing-diagram box highlights both. */
  linkHighlight() {
    const over = (e) => {
      const el = e.target instanceof Element ? e.target.closest('[data-node]') : null;
      const key = el?.dataset.node ?? null;
      const only = !!el?.classList.contains('osc-tab');
      if (key !== this.hlKey || only !== this.hlDiagramOnly) this.highlight(key, only);
    };
    const out = (e) => { if (!e.relatedTarget || !this.root.contains(e.relatedTarget)) this.highlight(null); };
    this.root.onmouseover = over;
    this.root.onmouseleave = () => this.highlight(null);
    this.root.onfocusin = over;
    this.root.onfocusout = out;
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

    const nameIn = h('input.track-name', { value: inst.name ?? inst.id, maxlength: '32', placeholder: 'Track name', 'aria-label': 'Track name',
      oninput: (e) => {
        const cur = this.orders.instruments[idx()];
        cur.name = e.target.value;
        this.o.onChange();
        this.o.onRename?.();
      } });
    const loader = presetPicker(this.o.presets, (key) => this.loadPreset(key));
    // An untouched Init patch is a blank slate: nudge towards presets until the patch is edited.
    const hintLoad = () => loader.querySelector('button').classList.toggle('hint', isDefaultPatch(this.orders.instruments[idx()] ?? inst));
    hintLoad();
    const head = h('div.track-head', h('strong', `Track ${this.o.getActive() + 1}`), nameIn, loader);

    if (!patch) {
      // Not a template instrument (e.g. hand-written orders): only the output levels can be edited here.
      const change = () => this.o.onChange();
      pairDefaults(inst, defaultPatch());
      return h('div.patch', head, this.auditionBar(inst),
        h('p.muted', 'This instrument has a custom signal graph that this editor cannot show. Load a preset to replace it and edit it here.'),
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
      hintLoad();
      routing.lastElementChild.replaceWith(routingDiagram(patch));
      this.highlight(this.hlKey, this.hlDiagramOnly);
      this.o.onChange();
    };
    const oscTabs = [];
    const oscRow = (o, n) => {
      const row = node(`osc${n}`, h('div.osc'));
      const edit = () => { // silent oscillators are greyed out, and so is their tab
        row.classList.toggle('off', !(o.level > 0));
        oscTabs[n - 1]?.classList.toggle('off', !(o.level > 0));
        change();
      };
      row.classList.toggle('off', !(o.level > 0));
      row.append(
        h('div.osc-head', h('strong', `Osc ${n}`), select('', o, 'wave', WAVES, change)),
        knob('level', o, 'level', { min: 0, max: 1 }, edit),
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
      return row;
    };
    const noise = patch.noise;
    // An envelope with its sub-heading (and optional amount slider), for use inside a larger module.
    const envelope = (key, title, e, amount) => node(key, h('div.env-sec',
      h('h5.sub', title),
      adsrControl(e, change, { defaults: DEFAULTS.get(e) }),
      amount ? knob(amount.label, e, 'amount', amount, change)
        // No amount slider: an invisible copy of one keeps the sliders level with the other envelopes' (wide layout only).
        : h('div.env-spacer', { 'aria-hidden': 'true' }, knob('amount', { v: 0 }, 'v', { min: 0, max: 1 }, () => {}))));

    // Per-column LFO depth: how much the LFO modulates that column's target. Tagged 'lfo' so it links to the LFO box.
    // The "LFO →" label is hidden when the columns sit side by side (CSS draws a connector to the column instead).
    const TARGETS = { pitch: 'pitch', cutoff: 'filter cutoff', amp: 'volume' };
    const lfoAmount = (key, o) => h('div.lfo-amt', { title: `LFO depth → ${TARGETS[key]}` }, knob('LFO →', patch.lfo, key, o, change));
    const target = (el) => { el.classList.add('lfo-target'); return el; }; // a column the LFO row modulates
    // The LFO's own controls take the strip above the Misc column (nothing in Misc is modulated).
    const oscRows = patch.osc.map((o, i) => oscRow(o, i + 1));
    const showOsc = (i) => {
      this.oscTab = i;
      oscRows.forEach((r, k) => { r.hidden = k !== i; });
      oscTabs.forEach((t, k) => { t.classList.toggle('on', k === i); t.setAttribute('aria-pressed', String(k === i)); });
    };
    patch.osc.forEach((o, i) => oscTabs.push(node(`osc${i + 1}`, h('button.osc-tab', {
      type: 'button', title: `Oscillator ${i + 1}${o.level > 0 ? '' : ' (silent)'}`, onclick: () => showOsc(i),
    }, String(i + 1)))));
    patch.osc.forEach((o, i) => oscTabs[i].classList.toggle('off', !(o.level > 0)));
    showOsc(Math.min(this.oscTab, patch.osc.length - 1));

    const lfoRow = node('lfo', h('div.lfo-row',
      h('div.lfo-ctl',
        h('div.lfo-head', h('strong', 'LFO'), select('', patch.lfo, 'wave', WAVES, change)),
        knob('rate', patch.lfo, 'rate', { min: 0.1, max: 20, log: true, unit: ' Hz' }, change)),
      lfoAmount('pitch', { min: 0, max: 200, step: 1, unit: ' ct' }),
      lfoAmount('cutoff', { min: 0, max: 4000, step: 10, unit: ' Hz' }),
      lfoAmount('amp', { min: 0, max: 1 })));

    return h('div.patch', head, this.auditionBar(inst), this.section('nodes', 'Node configuration', 'nodesOpen', h('div.nodes-body',
      lfoRow,
      h('div.patch-cols',
        module(null,
          node('noise', h('div.noise-sec',
            h('h5.sub', 'Noise'),
            select('color', noise, 'color', ['white', 'pink'], change),
            knob('level', noise, 'level', { min: 0, max: 1 }, change),
            check('through filter', () => noise.filtered, (on) => { noise.filtered = on; change(); })))),
        target(module(null,
          h('div.mod-head', h('h4', 'Oscillators'), h('div.osc-tabs', oscTabs)),
          oscRows,
          envelope('penv', 'Pitch envelope', patch.penv, { label: 'amount', min: -4800, max: 4800, step: 10, unit: ' ct' }))),
        target(node('filter', module('Filter',
            select('type', patch.filter, 'mode', FILTER_MODES, change),
            knob('cutoff', patch.filter, 'freq', { min: 20, max: 20000, log: true, unit: ' Hz' }, change),
            knob('resonance', patch.filter, 'q', { min: 0.1, max: 20, log: true }, change),
            knob('key track', patch.filter, 'key_track', { min: 0, max: 1 }, change),
            node('drive', knob('drive', patch, 'drive', { min: 0, max: 20, step: 0.5 }, change)),
          envelope('fenv', 'Filter envelope', patch.fenv, { label: 'amount', min: -8000, max: 8000, step: 10, unit: ' Hz' })))),
        target(node('amp', module('Amplifier + FX',
          knob('level', patch, 'gain', { min: 0, max: 1 }, change),
          knob('delay', patch, 'send_delay', { min: 0, max: 1 }, change),
          knob('reverb', patch, 'send_reverb', { min: 0, max: 1 }, change),
          envelope('aenv', 'Amp envelope', patch.aenv))))))), routing);
  }
}

/**
 * A "Load preset" button that opens a small non-modal list of presets with a Cancel button. Picking a preset calls
 * `onPick(key)` and closes the list; Cancel, Escape or a click anywhere outside the list closes it without picking.
 */
function presetPicker(presets, onPick) {
  const dlg = h('dialog.preset-dialog', { 'aria-label': 'Load preset' });
  const btn = h('button', { 'aria-haspopup': 'dialog' }, 'Load preset');
  const wrap = h('div.loader', btn, dlg);

  const onDown = (e) => { if (!dlg.contains(e.target) && e.target !== btn) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    dlg.close();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function open() {
    dlg.replaceChildren(
      h('div.preset-list', [...presets].map(([key, p]) =>
        h('button.preset-item', { onclick: () => { close(); onPick(key); } }, p.label ?? key))),
      h('button.preset-cancel', { onclick: close }, 'Cancel'));
    dlg.show(); // show(), not showModal(): the rest of the page stays interactive
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }
  btn.addEventListener('click', () => (dlg.open ? close() : open()));
  return wrap;
}
