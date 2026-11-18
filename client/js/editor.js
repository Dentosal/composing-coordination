// Instrument panel: a tab per instrument, and a fixed-architecture synth patch editor (see synth.js).
import { h, clear } from './dom.js';
import { Auditioner } from './audition.js';
import { adsrControl } from './adsr.js';
import { icon } from './icons.js';
import { helpButton } from './help.js';
import { downloadText } from './download.js';
import { routingDiagram } from './routing.js';
import { shapePlot } from './shapeplot.js';
import { FILTER_MODES, SHAPES, WAVES, buildInstrument, usesFilter2, defaultPatch, isDefaultPatch, parseInstrument, patchToFile, readPatchFile } from './synth.js';

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
/** A fresh track: a copy of the Init preset and an empty lane, with an instrument id that no track in `orders` uses. */
export function newTrack(orders, presets) {
  const taken = new Set(orders.instruments.map((i) => i.id));
  let k = 1;
  while (taken.has(`track${k}`)) k++;
  const id = `track${k}`;
  const base = presets.get('init')?.instrument;
  return { instrument: { ...structuredClone(base), id, name: presets.get('init')?.label ?? 'Init' }, lane: { instrument: id, steps: [] } };
}

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
  while (lanes.length < n) {
    const t = newTrack({ instruments }, presets);
    instruments.push(t.instrument);
    lanes.push(t.lane);
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
  const text = (v) => (o.fixed != null ? String(Number(Number(v).toFixed(o.fixed))) : fmt(v)); // the unit is shown beside the field, not inside it; `fixed`: decimals to keep
  const field = h('input.val', { type: 'text', inputmode: 'decimal', value: text(obj[key]), spellcheck: 'false',
    title: 'Type a value, or use ↑ ↓ (Shift: ×10)', 'aria-label': label });
  const slider = h('input', {
    title: o.snap ? `Double-click to reset. Hold Shift while dragging to snap to multiples of ${o.snap}` : 'Double-click to reset',
    type: 'range', min: log ? '0' : String(min), max: log ? '1' : String(max), step: log ? '0.001' : String(step),
    value: String(toSlider(obj[key])),
    oninput: (e) => {
      let v = fromSlider(parseFloat(e.target.value));
      if (o.snap && shift) { // Shift held during the drag: land on a multiple of `snap` (the thumb follows)
        v = normalize(Math.round(v / o.snap) * o.snap);
        slider.value = String(toSlider(v));
      }
      obj[key] = v;
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
  // Shift during a mouse drag snaps to multiples of `o.snap` (if given). The slider's own events carry no modifier state,
  // so follow it from the pointer (on the window: a drag often leaves the slider) and from the Shift key itself. The state
  // is kept for a moment after the release, because some browsers commit one last value just after it.
  let shift = false;
  if (o.snap) {
    let release = null;
    const snapNow = () => {
      const v = normalize(Math.round(obj[key] / o.snap) * o.snap);
      if (v !== obj[key]) { apply(v); field.value = text(v); }
    };
    const onKey = (e) => {
      if (e.key !== 'Shift') return;
      shift = e.type === 'keydown';
      if (shift) snapNow();
    };
    const onMove = (e) => { shift = e.shiftKey; };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      shift = false;
      release = null;
    };
    function end() {
      if (release) return;
      if (shift) snapNow(); // the value the drag ended on
      window.removeEventListener('pointermove', onMove);
      release = setTimeout(stop, 150); // a late final input event is still snapped
    }
    slider.addEventListener('pointerdown', (e) => {
      if (release) { clearTimeout(release); stop(); }
      shift = e.shiftKey;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      if (shift) snapNow();
    });
  }
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

/**
 * A bare vertical slider (no label or value field; hover for the name and exact value, double-click to reset), for
 * tight spots like the waveshaper. Writes `obj[key]` and calls `change` on every input. `o`: {label, min, max, step, unit, def}.
 */
function vslider(obj, key, o, change) {
  const { label, min, max, step = 0.01, unit = '' } = o;
  const describe = () => `${label}: ${fmt(obj[key])}${unit} (double-click to reset)`;
  const input = h('input.vslider', {
    type: 'range', min: String(min), max: String(max), step: String(step), value: String(obj[key]),
    title: describe(), 'aria-label': label,
    oninput: (e) => { obj[key] = parseFloat(e.target.value); input.title = describe(); change(); },
    ondblclick: () => {
      const def = o.def ?? DEFAULTS.get(obj)?.[key];
      if (def == null) return;
      obj[key] = def;
      input.value = String(def);
      input.title = describe();
      change();
    },
  });
  return input;
}

/** The filters a sound source can go through: its `route` is 1, 2, or 0 for none. (In series, filter 1 runs on into filter 2.) */
const ROUTES = [[1, 'filter 1'], [2, 'filter 2'], [0, 'bypass']];

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
    this.filterTab = 0; // and which filter in the Filter box
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

  /** Replace the active track's instrument, keeping its id (so the lane stays attached). */
  replaceActive(inst, name) {
    const cur = this.active;
    if (!cur) return;
    const i = this.orders.instruments.indexOf(cur);
    this.orders.instruments[i] = { ...inst, id: cur.id, name };
    this.o.onRename?.();
    this.o.onMode?.(); // a preset or file can switch the track between steps and piano roll
    this.o.onChange();
    this.render();
  }

  /** Overwrite the active track's patch with a preset. */
  loadPreset(key) {
    const p = this.o.presets.get(key);
    if (p) this.replaceActive(structuredClone(p.instrument), p.label ?? key);
  }

  /** Save the active track's patch as a .json file the user can keep and import later. */
  exportPatch() {
    const cur = this.active;
    if (!cur) return;
    const text = JSON.stringify(patchToFile(cur), null, 1) + '\n';
    const slug = (cur.name || cur.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'patch';
    downloadText(`${slug}.json`, text);
  }

  /** Load a patch file into the active track. Throws a readable Error for files that aren't patches. */
  async importPatchFile(file) {
    const { label, patch, pianoRoll } = readPatchFile(await file.text());
    const cur = this.active;
    if (!cur) return;
    this.replaceActive(buildInstrument(cur.id, patch, label, pianoRoll), label);
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
      const only = !!el && (el.classList.contains('osc-tab') || el.hasAttribute('data-diagram-only'));
      if (key !== this.hlKey || only !== this.hlDiagramOnly) this.highlight(key, only);
    };
    const out = (e) => { if (!e.relatedTarget || !this.root.contains(e.relatedTarget)) this.highlight(null); };
    this.root.onmouseover = over;
    this.root.onmouseleave = () => this.highlight(null);
    this.root.onfocusin = over;
    this.root.onfocusout = out;
  }

  /** Note picker, velocity, and three ways to play it: once, held while pressed, or looped at a BPM multiple. */
  /** A toggle for a details section ("Patch", "Signal routing"), so it can live on the audition row instead of its own summary line. */
  detailsToggle(details, label) {
    const btn = h('button.node-toggle', { type: 'button', title: `Show or hide: ${label.toLowerCase()}`, onclick: () => { details.open = !details.open; sync(); } });
    const sync = () => {
      btn.textContent = `${details.open ? '▼' : '▶'} ${label}`;
      btn.setAttribute('aria-expanded', String(details.open));
    };
    details.addEventListener('toggle', sync);
    sync();
    return btn;
  }

  auditionBar(inst, toggles = []) {
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
    const holdBtn = h('button.hold', { title: 'Hold: sounds the note while you press and hold', 'aria-label': 'Hold' }, '●');
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
      const on = looping();
      loopBtn.textContent = on ? '■' : '↻';
      loopBtn.title = on ? 'Stop the loop' : 'Loop: repeat the note at the chosen rate';
      loopBtn.setAttribute('aria-label', on ? 'Stop loop' : 'Loop');
      loopBtn.classList.toggle('on', on);
    };
    sync();

    // The toggles stay on the left; the audition controls are one group pushed to the right (it wraps as a unit).
    return h('div.audition',
      toggles,
      h('div.audition-main',
        h('strong', 'Audition'),
        h('label', 'note', noteSel),
        h('label', 'velocity', vel, velOut),
        h('button', { title: 'Once: play the note one beat long', 'aria-label': 'Once', onclick: () => this.aud.once(current(), st.note, st.vel) }, '▶'),
        holdBtn, h('span.sep'),
        h('span.loop', loopBtn, h('label', 'rate', rateSel))));
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
    const pianoChk = h('label.check.piano-roll', { title: 'Show this track as a piano roll: each note is drawn as a bar from its start to the next note or off (the sound is the same)' },
      h('input', { type: 'checkbox', checked: inst.piano_roll === true, onchange: (e) => {
        const cur = this.orders.instruments[idx()];
        if (e.target.checked) cur.piano_roll = true; else delete cur.piano_roll;
        this.o.onChange();
        this.o.onMode?.();
      } }), 'Piano roll');
    // Sessions with unlimited tracks can delete one (never the last): the button sits left of "Load preset".
    const deleteBtn = this.o.onDeleteTrack
      ? h('button.icon-btn', { type: 'button', title: 'Delete this track', 'aria-label': 'Delete this track', disabled: !this.o.canDeleteTrack?.(),
        onclick: () => this.o.onDeleteTrack(this.o.getActive()) }, icon('trash'))
      : null;
    const loader = presetPicker(this.o.presets, (key) => this.loadPreset(key));
    // An untouched Init patch is a blank slate: nudge towards presets until the patch is edited.
    const hintLoad = () => loader.querySelector('button').classList.toggle('hint', isDefaultPatch(this.orders.instruments[idx()] ?? inst));
    hintLoad();
    // Export / import: patches as files, so players can keep their own sounds locally.
    const ioMsg = h('span.io-msg', { role: 'status' });
    let msgT;
    const say = (text) => { ioMsg.textContent = text; clearTimeout(msgT); msgT = setTimeout(() => { ioMsg.textContent = ''; }, 7000); };
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true,
      onchange: async (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // so picking the same file again still fires
        if (!file) return;
        try { await this.importPatchFile(file); } catch (err) { say(err.message); }
      } });
    const exportTitle = 'Export: save this track\'s patch as a file';
    const importTitle = 'Import: load a patch file into this track (replaces its patch)';
    const exportBtn = h('button.icon-btn', { type: 'button', title: exportTitle, 'aria-label': exportTitle, onclick: () => this.exportPatch() }, icon('download'));
    const importBtn = h('button.icon-btn', { type: 'button', title: importTitle, 'aria-label': importTitle, onclick: () => fileIn.click() }, icon('upload'));
    const head = h('div.track-head', h('strong', `Track ${this.o.getActive() + 1}`), nameIn, pianoChk,
      h('div.loader-group', ioMsg, deleteBtn, loader, exportBtn, importBtn, fileIn,
        helpButton({ title: 'Shaping a sound', label: 'Help: the patch editor', body: patchHelp() })));

    if (!patch) {
      // Not a template instrument (e.g. hand-written orders): only the output levels can be edited here.
      const change = () => this.o.onChange();
      pairDefaults(inst, defaultPatch());
      const nodes = this.section('nodes', 'Node configuration', 'nodesOpen', h('div.patch-grid', module('Output',
        knob('level', inst, 'gain', { min: 0, max: 1 }, change),
        knob('delay', inst, 'send_delay', { min: 0, max: 1 }, change),
        knob('reverb', inst, 'send_reverb', { min: 0, max: 1 }, change))));
      return h('div.patch', head, this.auditionBar(inst, [this.detailsToggle(nodes, 'Patch')]),
        h('p.muted', 'This instrument has a custom signal graph that this editor cannot show. Load a preset to replace it and edit it here.'),
        nodes);
    }

    // Every edit rebuilds the graph from the patch and swaps it in; lanes refer to the id, which never changes.
    pairDefaults(patch, defaultPatch());
    const routing = this.section('routing', 'Signal routing', 'routingOpen', routingDiagram(patch));
    let syncFm = () => {}; // refreshes the FM box (ratio helper, dimming) after any patch edit; set below
    let syncFilterTabs = () => {}; // dims the filter tab nothing is routed to; set below
    let syncShape = () => {}; // redraws the waveshaper plot; set below
    const change = () => {
      syncFm();
      syncFilterTabs();
      syncShape();
      const prev = this.orders.instruments[idx()];
      this.orders.instruments[idx()] = buildInstrument(inst.id, patch, prev.name, prev.piano_roll === true);
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
        h('div.osc-head', select('', o, 'wave', WAVES, change),
          check('fixed pitch', () => o.fixed_hz != null, (on) => {
            o.fixed_hz = on ? 220 : null;
            change();
            this.render();
          })),
        knob('level', o, 'level', { min: 0, max: 1 }, edit),
        o.fixed_hz == null
          ? knob('pitch', o, 'semitones', { min: -48, max: 48, step: 0.01, fixed: 2, snap: 1, unit: ' st' }, change)
          : knob('pitch', o, 'fixed_hz', { min: 20, max: 2000, log: true, unit: ' Hz', def: 220 }, change),
        knob('unison', o, 'unison', { min: 1, max: 7, step: 1, unit: ' voices' }, change),
        knob('spread', o, 'spread', { min: 0, max: 100, step: 1, unit: ' ct' }, change));
      return row;
    };
    const noise = patch.noise;
    // An envelope with its sub-heading (and optional amount slider), for use inside a larger module.
    const envelope = (key, title, e, amount) => node(key, h('div.env-sec',
      h('h5.sub', title),
      adsrControl(e, change, { defaults: DEFAULTS.get(e) }),
      amount ? knob(amount.label, amount.obj ?? e, amount.key ?? 'amount', amount, change) // the amp envelope's slot holds the output level
        // No amount slider: an invisible copy of one keeps the sliders level with the other envelopes' (wide layout only).
        : h('div.env-spacer', { 'aria-hidden': 'true' }, knob('amount', { v: 0 }, 'v', { min: 0, max: 1 }, () => {}))));

    // Per-column LFO depth: how much the LFO modulates that column's target. Tagged 'lfo' so it links to the LFO box.
    // The "LFO →" label is hidden when the columns sit side by side (CSS draws a connector to the column instead).
    const TARGETS = { pitch: 'pitch', cutoff: 'filter cutoff', amp: 'volume' };
    // A depth of 0 means the LFO does nothing to that column: its connector and the column's top bar are greyed out.
    let patchEl = null;
    const syncLfo = () => {
      for (const key of Object.keys(TARGETS)) {
        patchEl?.querySelectorAll(`[data-lfo="${key}"]`).forEach((el) => el.classList.toggle('lfo-zero', !(patch.lfo[key] > 0)));
      }
    };
    const lfoChange = () => { syncLfo(); change(); };
    const lfoAmount = (key, o) => h('div.lfo-amt', { title: `LFO depth → ${TARGETS[key]}`, 'data-lfo': key },
      knob('LFO →', patch.lfo, key, o, lfoChange));
    const target = (el, key) => { el.classList.add('lfo-target'); el.dataset.lfo = key; return el; }; // a column the LFO row modulates
    // The LFO's own controls take the strip below the Noise/FM column (nothing in it is modulated).
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
        h('div.lfo-head', h('strong', 'LFO'), select('', patch.lfo, 'wave', WAVES, change),
          knob('rate', patch.lfo, 'rate', { min: 0.1, max: 20, log: true, unit: ' Hz' }, change))),
      lfoAmount('pitch', { min: 0, max: 200, step: 1, unit: ' ct' }),
      lfoAmount('cutoff', { min: 0, max: 4000, step: 10, unit: ' Hz' }),
      lfoAmount('amp', { min: 0, max: 1 })));

    // FM box: osc 2 frequency-modulates osc 1. "ratio" is osc 2's frequency over osc 1's; picking one sets osc 2's pitch.
    const fm = patch.fm;
    const RATIOS = [[0.25, '1 : 4'], [0.5, '1 : 2'], [1, '1 : 1'], [1.5, '3 : 2'], [2, '2 : 1'], [3, '3 : 1'], [4, '4 : 1'], [5, '5 : 1'], [6, '6 : 1'], [7, '7 : 1'], [8, '8 : 1']];
    const ratioSelect = h('select', {
      title: "Osc 2's frequency relative to osc 1's. Whole ratios sound harmonic, others clangorous.",
      onchange: (e) => {
        const o1 = patch.osc[0];
        patch.osc[1].semitones = Math.min(48, Math.max(-48, Number((o1.semitones + 12 * Math.log2(Number(e.target.value))).toFixed(3))));
        change();
        this.render(); // the pitch knob of osc 2 shows the new value
      },
    });
    const fmBox = node('fm', h('div.fm-sec',
      h('div.sec-head', h('h5.sub', 'FM'), check('osc 2 → osc 1', () => fm.on, (on) => { fm.on = on; change(); })),
      knob('depth', fm, 'depth', { min: 0, max: 10, step: 0.05 }, change),
      h('label.knob', h('span', 'ratio'), ratioSelect)));
    syncFm = () => {
      const [o1, o2] = patch.osc;
      const free = o1.fixed_hz == null && o2.fixed_hz == null;
      const cur = 2 ** ((o2.semitones - o1.semitones) / 12);
      const hit = RATIOS.find(([r]) => Math.abs(12 * Math.log2(cur / r)) < 0.01);
      ratioSelect.replaceChildren(
        ...RATIOS.map(([r, text]) => h('option', { value: String(r), selected: free && hit?.[0] === r }, text)),
        ...(free && !hit ? [h('option', { value: String(cur), selected: true }, `${Number(cur.toPrecision(3))} : 1`)] : []),
        ...(free ? [] : [h('option', { selected: true }, 'fixed pitch')]));
      ratioSelect.disabled = !free;
      fmBox.classList.toggle('off', !fm.on);
    };
    syncFm();

    // Waveshaper: drive (0 = off), the curve, and the curve's own second setting (shown only for shapes that have one).
    const shapeParam = h('div.vslot'); // the slot beside the plot for the shape's second setting (empty for shapes without one)
    const renderShapeParam = () => {
      const def = SHAPES.find((sh) => sh.id === patch.shape)?.param;
      shapeParam.replaceChildren(...(def ? [vslider(patch, 'shapeParam', def, change)] : []));
    };
    renderShapeParam();
    const plot = shapePlot();
    syncShape = () => plot.update(patch);
    syncShape();
    // The shape menu sits in the module's header row, beside the title.
    const shapeSelect = h('select.head-select', {
      title: 'The distortion curve', 'aria-label': 'Waveshaper shape',
      onchange: (e) => {
        patch.shape = e.target.value;
        patch.shapeParam = SHAPES.find((sh) => sh.id === patch.shape).param?.def ?? patch.shapeParam;
        renderShapeParam();
        change();
      },
    }, SHAPES.map((sh) => h('option', { value: sh.id, selected: sh.id === patch.shape }, sh.label)));
    // Fixed layout whatever the shape: the second setting's slider (its slot stays empty for shapes without one), the plot, drive.
    const shaperBox = h('div.shaper-sec',
      shapeParam,
      plot.el,
      h('div.vslot', vslider(patch, 'drive', { label: 'Drive', min: 0, max: 20, step: 0.5 }, change)));

    // Which filter each sound source goes through: a tri-state button per source (the oscillators' share a row in the Routing box,
    // noise has its own in its header). A silent source's button is dimmed.
    const routeRows = [];
    // Each click moves the source on to the next of filter 1 -> filter 2 -> bypass.
    const ROUTE_TEXT = Object.fromEntries(ROUTES);
    const routeButton = (src, name, key = null) => {
      const btn = h('button.tri', { type: 'button' });
      if (key) { btn.dataset.node = key; btn.dataset.diagramOnly = ''; } // hovering it lights that oscillator's diagram box, like its tab
      const show = () => {
        btn.textContent = ROUTE_TEXT[src.route];
        btn.dataset.state = String(src.route);
        btn.title = `${name}: ${ROUTE_TEXT[src.route]} (click for ${ROUTE_TEXT[ROUTES[(ROUTES.findIndex(([v]) => v === src.route) + 1) % ROUTES.length][0]]})`;
        btn.setAttribute('aria-label', btn.title);
      };
      btn.onclick = () => {
        src.route = ROUTES[(ROUTES.findIndex(([v]) => v === src.route) + 1) % ROUTES.length][0];
        show();
        change();
      };
      show();
      routeRows.push([btn, src]);
      return btn;
    };
    const oscRoutes = h('div.knob.route-osc', h('span', 'oscillators'),
      h('div.tri-group', patch.osc.map((o, i) => routeButton(o, `Oscillator ${i + 1}`, `osc${i + 1}`))));

    // Two toggle buttons in the Routing box's header, each showing its current state and flipping on click.
    //  serial / parallel: filter 1 feeds filter 2, or the two filters work side by side.
    //  one / both: the waveshaper acts after filter 1 only (right after it in parallel, between the filters in serial)
    //  or after both filters (after the two are summed in parallel, after filter 2 in serial).
    const modeBtn = h('button.tog', {
      type: 'button',
      onclick: () => { patch.filterMode = patch.filterMode === 'serial' ? 'parallel' : 'serial'; change(); },
    });
    const posBtn = h('button.tog', {
      type: 'button',
      onclick: () => { patch.shaperPos = patch.shaperPos === 'mid' ? 'post' : 'mid'; change(); },
    });
    const syncLayout = () => {
      const serialMode = patch.filterMode === 'serial';
      const one = patch.shaperPos === 'mid';
      modeBtn.textContent = patch.filterMode;
      modeBtn.dataset.on = serialMode ? '1' : '0';
      modeBtn.title = serialMode
        ? 'Serial: filter 1 feeds filter 2 (click for parallel, side by side)'
        : 'Parallel: the two filters work side by side (click for serial, filter 1 feeding filter 2)';
      posBtn.textContent = one ? 'one' : 'both';
      posBtn.dataset.on = one ? '1' : '0';
      posBtn.title = one
        ? `Waveshaper after filter 1 only (${serialMode ? 'between the filters' : 'right after it'}); click for after both filters`
        : `Waveshaper after both filters (${serialMode ? 'after filter 2' : 'after they are summed'}); click for after filter 1 only`;
      for (const b of [modeBtn, posBtn]) {
        b.setAttribute('aria-pressed', b.dataset.on === '1' ? 'true' : 'false');
        b.setAttribute('aria-label', b.title);
      }
    };
    syncLayout();
    // Linked to the diagram's sum node (Σ), where the signal paths the Routing box sets up come together.
    const routingBox = node('sum', module(null,
      h('div.mod-head', h('h4', 'Routing'), h('div.tog-group',
        h('span.tog-pair', h('span.tog-label', { title: 'Filters: how the two filters are connected' }, 'F:'), modeBtn),
        h('span.tog-pair', h('span.tog-label', { title: 'Waveshaper: which filters it follows' }, 'S:'), posBtn))),
      oscRoutes));

    // Two filters in tabs, each with its own envelope. Sources choose which one they go through (or none).
    const filterRow = (fk, ek, n) => node(n === 1 ? 'filter' : 'filter2', h('div.filt',
      select('type', patch[fk], 'mode', FILTER_MODES, change),
      knob('cutoff', patch[fk], 'freq', { min: 20, max: 20000, log: true, unit: ' Hz' }, change),
      knob('resonance', patch[fk], 'q', { min: 0.1, max: 20, log: true }, change),
      knob('key track', patch[fk], 'key_track', { min: 0, max: 1 }, change),
      envelope(ek, 'Filter envelope', patch[ek], { label: 'amount', min: -8000, max: 8000, step: 10, unit: ' Hz' })));
    const filterRows = [filterRow('filter', 'fenv', 1), filterRow('filter2', 'fenv2', 2)];
    const filterTabs = [];
    const showFilter = (i) => {
      this.filterTab = i;
      filterRows.forEach((r, k) => { r.hidden = k !== i; });
      filterTabs.forEach((t, k) => { t.classList.toggle('on', k === i); t.setAttribute('aria-pressed', String(k === i)); });
    };
    [1, 2].forEach((n, i) => filterTabs.push(node(n === 1 ? 'filter' : 'filter2', h('button.osc-tab', {
      type: 'button', onclick: () => showFilter(i),
    }, String(n)))));
    syncFilterTabs = () => {
      const sources = [...patch.osc, patch.noise];
      [1, 2].forEach((n, i) => {
        const used = n === 1 ? sources.some((src) => src.route === 1) : usesFilter2(patch);
        filterTabs[i].classList.toggle('off', !used);
        filterTabs[i].title = `Filter ${n}${used ? '' : ' (nothing goes through it)'}`;
      });
      for (const [row, src] of routeRows) row.classList.toggle('off', !(src.level > 0));
      syncLayout();
    };
    syncFilterTabs();
    showFilter(Math.min(this.filterTab, filterRows.length - 1));

    const nodes = this.section('nodes', 'Node configuration', 'nodesOpen', h('div.nodes-body',
      h('div.patch-cols',
        h('div.col-stack',
          module(null,
            node('noise', h('div.noise-sec',
              h('div.sec-head', h('h5.sub', 'Noise'),
                h('div.head-group',
                  h('select.head-select', {
                    title: 'White or pink noise', 'aria-label': 'Noise color',
                    onchange: (e) => { noise.color = e.target.value; change(); },
                  }, ['white', 'pink'].map((v) => h('option', { value: v, selected: v === noise.color }, v))),
                  routeButton(noise, 'Noise'))),
              knob('level', noise, 'level', { min: 0, max: 1 }, change)))),
          module(null, fmBox),
          node('drive', module(null, h('div.mod-head', h('h4', 'Waveshaper'), shapeSelect), shaperBox))),
        target(module(null,
          h('div.mod-head', h('h4', 'Oscillators'), h('div.osc-tabs', oscTabs)),
          oscRows,
          envelope('penv', 'Pitch envelope (shared)', patch.penv, { label: 'amount', min: -4800, max: 4800, step: 10, unit: ' ct' })), 'pitch'),
        target(module(null,
          h('div.mod-head', h('h4', 'Filter'), h('div.osc-tabs', filterTabs)),
          filterRows), 'cutoff'),
        // Right-hand column: routing, effect sends, then the amplifier (the part the LFO's volume depth modulates) at the bottom.
        h('div.col-stack.sink',
          routingBox,
          node('fx', module('Effects',
            knob('delay', patch, 'send_delay', { min: 0, max: 1 }, change),
            knob('reverb', patch, 'send_reverb', { min: 0, max: 1 }, change))),
          target(node('amp', module(null,
            envelope('aenv', 'Amplifier envelope', patch.aenv, { label: 'level', obj: patch, key: 'gain', min: 0, max: 1 }))), 'amp'))),
      lfoRow));
    patchEl = h('div.patch', head, this.auditionBar(inst, [this.detailsToggle(nodes, 'Patch'), this.detailsToggle(routing, 'Signal routing')]), nodes, routing);
    syncLfo();
    return patchEl;
  }
}

/** Presets grouped by `category` (a preset without one goes under "Other"), in order of first appearance. */
function categories(presets) {
  const groups = new Map();
  for (const e of presets) {
    const cat = e[1].category ?? 'Other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(e);
  }
  return [...groups];
}

/** Contents of the patch editor's help dialog. */
function patchHelp() {
  return [
    'A patch is a small synthesizer. Sound sources go through a filter (or two) and an amplifier, and envelopes shape how the sound changes over the length of each note. The sound of the track you have selected is what you edit here.',
    h('h3', 'Sound sources'),
    h('ul',
      h('li', h('strong', 'Oscillators'), ': up to three tone generators. Pick a wave shape, set the pitch (in semitones from the note, down to hundredths of a semitone for detuning; hold Shift while dragging the slider to snap to whole semitones); stack them, or use unison (several detuned copies of one oscillator, spread across the given cents) for a thicker sound.'),
      h('li', h('strong', 'Noise'), ': white or pink noise, good for drums and breath. The Routing box sets, for each source, whether it goes through filter 1, filter 2 or no filter.')),
    h('h3', 'Filter and drive'),
    h('ul',
      h('li', h('strong', 'Filter'), ': removes frequencies. Cutoff sets where, resonance emphasises that spot, and key track makes higher notes open the filter more. There are two filters (tabs 1 and 2), each with its own envelope. The Routing box sends each source to filter 1, filter 2 or past them (bypass). Its "parallel / serial" button sets how the filters are connected: side by side, or filter 1 feeding filter 2 (serial: a source on filter 1 runs on through filter 2, and one on filter 2 enters at the second filter). The LFO cutoff depth moves both. The second filter is only active while something goes through it.'),
      h('li', h('strong', 'Drive'), ': distortion that makes the sound thicker and louder. By default it comes after both filters; the "one / both" button in the Routing box can put it after filter 1 only instead (right after it in parallel, between the two filters in serial). 0 switches it off. Shape picks the kind: soft clip (smooth), hard clip (harsh), foldback (the peaks bounce back: metallic), asymmetric (even harmonics: warm) and bitcrush (few amplitude steps; "bits" sets how many). Quiet sounds are crushed harder, so raise the drive to bring the level into the crusher.')),
    h('h3', 'Envelopes'),
    h('ul',
      h('li', 'Each envelope has Attack, Decay, Sustain and Release: how fast the sound rises, falls to its held level, and fades when the note ends.'),
      h('li', h('strong', 'Amp'), ' shapes the volume, ', h('strong', 'filter'), ' moves that filter\'s cutoff, and ', h('strong', 'pitch'), ' bends the pitch at the start of a note (kicks and toms). "Amount" sets how far.')),
    h('h3', 'LFO'),
    h('ul', h('li', 'A slow repeating wobble you can send to pitch (vibrato), cutoff (wah) or volume (tremolo). The three sliders set how much goes where.')),
    h('h3', 'Output'),
    h('ul', h('li', 'Level is the track volume. Delay and reverb set how much of the sound goes to the shared echo and room effects.')),
    h('h3', 'Presets and files'),
    h('ul',
      h('li', "Load preset replaces this track's sound with a starting point."),
      h('li', 'Export saves the patch as a file, and import loads one into this track.'),
      h('li', 'The Audition bar plays the sound while you tweak it, and "Signal routing" draws how it is wired.')),
  ];
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
      h('div.preset-list', categories(presets).map(([cat, items]) => h('div.preset-group',
        h('div.preset-cat', cat),
        items.map(([key, p]) => h('button.preset-item', { onclick: () => { close(); onPick(key); } }, p.label ?? key))))),
      h('button.preset-cancel', { onclick: close }, 'Cancel'));
    dlg.show(); // show(), not showModal(): the rest of the page stays interactive
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }
  btn.addEventListener('click', () => (dlg.open ? close() : open()));
  return wrap;
}
