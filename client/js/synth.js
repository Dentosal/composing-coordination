// Fixed-architecture synth template. The editor works on a flat "patch" (a few dozen numbers); this module
// converts it to and from the orders instrument graph the server validates and renders. The server
// knows nothing about the template: it only ever sees an ordinary node/edge graph.
//
//   o1 o2 o3 noise -> level gains -> (filter 1 | filter 2 | direct) -> bus -> [drive] -> vca -> out
//   aenv -> vca.gain   fenv -> filter 1 freq   fenv2 -> filter 2 freq   penv -> o*.detune   lfo -> (pitch | cutoff | amp) depth gains
//   filters run side by side, or in series (filter 1 -> filter 2; then "filter 1" means through both, "filter 2" enters at filter 2).
//   The LFO's cutoff depth moves both filters; filter 2 and its envelope exist only while a source is routed to it.
//
// Every module always exists, so switching things on and off never loses settings: a silent oscillator
// is level 0, an unused modulation is amount 0. The exceptions are drive (0 omits the shaper), FM and filter 2: they are
// left out of the graph while they are off / unused and still at their default settings, so that graphs built before they
// existed are still recognised. Once their settings are changed they stay in the graph (FM unwired, filter 2 silent) so a
// reload keeps them.

export const OSC_COUNT = 3;
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
export const FILTER_MODES = ['lowpass', 'highpass', 'bandpass', 'notch'];
export const MIDDLE_C_HZ = 261.6255653005986; // as in the renderers: FM depth is stored as a gain in Hz at middle C
export const FILTER_ROUTINGS = ['parallel', 'serial'];
export const MIN_DRIVE = 0.1; // server minimum for a shaper node

const oscPatch = (level = 0) => ({
  wave: 'sawtooth', semitones: 0, detune: 0, fixed_hz: null, unison: 1, spread: 0, level, route: 1, // route: 1 = filter 1, 2 = filter 2, 0 = no filter
});

export function defaultPatch() {
  return {
    gain: 0.8,
    send_delay: 0,
    send_reverb: 0.1,
    osc: [oscPatch(0.5), oscPatch(), oscPatch()],
    noise: { color: 'white', level: 0, route: 1 },
    filter: { mode: 'lowpass', freq: 2000, q: 1, key_track: 0.5 },
    filterMode: 'parallel', // or 'serial'
    filter2: { mode: 'lowpass', freq: 2000, q: 1, key_track: 0.5 },
    drive: 0,
    fm: { on: false, depth: 1 }, // osc 2 frequency-modulates osc 1; depth is the modulation index (peak deviation / modulator frequency)
    aenv: { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.1 },
    fenv: { attack: 0.005, decay: 0.25, sustain: 0.3, release: 0.1, amount: 0 }, // amount in Hz
    fenv2: { attack: 0.005, decay: 0.25, sustain: 0.3, release: 0.1, amount: 0 },
    penv: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05, amount: 0 }, // amount in cents
    lfo: { wave: 'sine', rate: 5, pitch: 0, cutoff: 0, amp: 0 }, // depths: cents, Hz, gain
  };
}

const env = (id, e, amount) => ({
  id, type: 'env', attack: e.attack, decay: e.decay, sustain: e.sustain, release: e.release, amount,
});
const gainNode = (id, gain) => ({ id, type: 'gain', gain });
const FILTER_NODE = [null, 'lp', 'lp2'];
/** The node a source with this `route` feeds. */
const routeNode = (route) => FILTER_NODE[route] ?? 'bus';

/** The modulator's frequency in Hz at middle C: what an FM index of 1 means as a deviation (fixed-pitch oscillators: their own frequency). */
const fmBase = (o) => (o.fixed_hz != null ? o.fixed_hz : MIDDLE_C_HZ * 2 ** (o.semitones / 12));

const sameSettings = (a, b) => Object.keys(b).every((k) => a[k] === b[k]);
const DEFAULTS = defaultPatch();
/** True when the graph needs filter 2's nodes: it does something, or its settings (or the serial mode) were changed. */
const keepsFilter2 = (p) => usesFilter2(p) || p.filterMode === 'serial' || !sameSettings(p.filter2, DEFAULTS.filter2) || !sameSettings(p.fenv2, DEFAULTS.fenv2);

/** True when filter 2 does something (otherwise its nodes are left out of the graph): a source is routed to it, or, in series, to filter 1 (which feeds it). */
export const usesFilter2 = (p) => [...p.osc, p.noise].some((src) => src.route === 2 || (p.filterMode === 'serial' && src.route === 1));

/** Patch -> orders instrument. */
export function buildInstrument(id, p, name, pianoRoll = false) {
  const nodes = [];
  const edges = [];
  const edge = (from, to, port) => edges.push(port ? { from, to, port } : { from, to });

  p.osc.forEach((o, i) => {
    const n = { id: `o${i + 1}`, type: 'osc', wave: o.wave, semitones: o.semitones, detune: o.detune };
    if (o.unison > 1) n.unison = o.unison; // omitted at the defaults, so plain patches keep their old graph
    if (o.spread !== 0) n.spread = o.spread;
    if (o.fixed_hz != null) n.fixed_hz = o.fixed_hz;
    nodes.push(n, gainNode(`l${i + 1}`, o.level));
    edge(n.id, `l${i + 1}`);
    edge(`l${i + 1}`, routeNode(o.route));
    edge('penv', n.id, 'detune');
    edge('lfo_p', n.id, 'detune');
  });
  nodes.push({ id: 'n', type: 'noise', color: p.noise.color }, gainNode('ln', p.noise.level));
  edge('n', 'ln');
  edge('ln', routeNode(p.noise.route));

  nodes.push(
    { id: 'lp', type: 'filter', mode: p.filter.mode, freq: p.filter.freq, q: p.filter.q, key_track: p.filter.key_track },
    gainNode('bus', 1));
  edge('lp', p.filterMode === 'serial' && keepsFilter2(p) ? 'lp2' : 'bus');
  edge('fenv', 'lp', 'freq');
  edge('lfo_c', 'lp', 'freq');

  // FM: osc 2 -> fm gain -> osc 1 frequency. The gain is the peak deviation in Hz at middle C; with key_track 1 it
  // follows the note's pitch, so the index (deviation / modulator frequency) stays constant. Omitted when off.
  if (p.fm.on || p.fm.depth !== DEFAULTS.fm.depth) {
    // fround: the server stores 32-bit floats, and the graph must come back from it identical to what is built here.
    nodes.push({ id: 'fm', type: 'gain', gain: Math.fround(p.fm.depth * fmBase(p.osc[1])), ...(p.osc[1].fixed_hz == null ? { key_track: 1 } : {}) });
    if (p.fm.on) { // switched off, the node stays (only to remember the depth) but is not wired in
      edge('o2', 'fm');
      edge('fm', 'o1', 'freq');
    }
  }

  // Filter 2 (beside filter 1, or after it in series), while it does something or has non-default settings.
  if (keepsFilter2(p)) {
    nodes.push({ id: 'lp2', type: 'filter', mode: p.filter2.mode, freq: p.filter2.freq, q: p.filter2.q, key_track: p.filter2.key_track },
      env('fenv2', p.fenv2, p.fenv2.amount));
    edge('lp2', 'bus');
    edge('fenv2', 'lp2', 'freq');
    edge('lfo_c', 'lp2', 'freq');
  }

  let tail = 'bus';
  if (p.drive > 0) {
    nodes.push({ id: 'drv', type: 'shaper', drive: Math.max(MIN_DRIVE, p.drive) });
    edge('bus', 'drv');
    tail = 'drv';
  }
  nodes.push(gainNode('vca', 0), env('aenv', p.aenv, 1), env('fenv', p.fenv, p.fenv.amount), env('penv', p.penv, p.penv.amount));
  edge(tail, 'vca');
  edge('aenv', 'vca', 'gain');
  edge('lfo_a', 'vca', 'gain');

  nodes.push(
    { id: 'lfo', type: 'osc', wave: p.lfo.wave, semitones: 0, detune: 0, fixed_hz: p.lfo.rate },
    gainNode('lfo_p', p.lfo.pitch), gainNode('lfo_c', p.lfo.cutoff), gainNode('lfo_a', p.lfo.amp),
    { id: 'out', type: 'out' });
  edge('lfo', 'lfo_p');
  edge('lfo', 'lfo_c');
  edge('lfo', 'lfo_a');
  edge('vca', 'out');

  return { id, ...(name ? { name } : {}), ...(pianoRoll ? { piano_roll: true } : {}), gain: p.gain, send_delay: p.send_delay, send_reverb: p.send_reverb, nodes, edges };
}

// ------------------------------------------------------------------ parsing

/** Normalise an instrument so two spellings of the same graph compare equal. */
function canonical(inst) {
  const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const nodes = inst.nodes.map((n) => {
    const c = { ...n };
    if (c.type === 'osc') {
      c.semitones ??= 0;
      c.detune ??= 0;
      c.unison ??= 1;
      c.spread ??= 0;
      if (c.fixed_hz == null) delete c.fixed_hz;
    }
    if (c.type === 'filter' || c.type === 'gain') c.key_track ??= 0;
    return sortKeys(c);
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = inst.edges.map((e) => sortKeys({ from: e.from, to: e.to, ...(e.port ? { port: e.port } : {}) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ id: inst.id, gain: inst.gain, send_delay: inst.send_delay, send_reverb: inst.send_reverb, nodes, edges });
}

/** Orders instrument -> patch, or null when it is not exactly a template instrument (then it can't be edited here). */
export function parseInstrument(inst) {
  const by = new Map(inst.nodes.map((n) => [n.id, n]));
  const need = (id, type) => {
    const n = by.get(id);
    if (!n || n.type !== type) throw new Error(`missing ${id}`);
    return n;
  };
  const routedTo = (from, to) => inst.edges.some((e) => e.from === from && e.to === to && !e.port);
  const routeOf = (from) => (routedTo(from, 'lp') ? 1 : by.has('lp2') && routedTo(from, 'lp2') ? 2 : 0);
  try {
    const envOf = (id) => {
      const e = need(id, 'env');
      return { attack: e.attack, decay: e.decay, sustain: e.sustain, release: e.release };
    };
    const p = defaultPatch();
    p.gain = inst.gain;
    p.send_delay = inst.send_delay;
    p.send_reverb = inst.send_reverb;
    for (let i = 0; i < OSC_COUNT; i++) {
      const o = need(`o${i + 1}`, 'osc');
      p.osc[i] = {
        wave: o.wave, semitones: o.semitones ?? 0, detune: o.detune ?? 0, fixed_hz: o.fixed_hz ?? null, unison: o.unison ?? 1, spread: o.spread ?? 0,
        level: need(`l${i + 1}`, 'gain').gain, route: routeOf(`l${i + 1}`),
      };
    }
    p.noise = { color: need('n', 'noise').color, level: need('ln', 'gain').gain, route: routeOf('ln') };
    const lp = need('lp', 'filter');
    p.filter = { mode: lp.mode, freq: lp.freq, q: lp.q, key_track: lp.key_track ?? 0 };
    if (by.has('lp2')) {
      const lp2 = need('lp2', 'filter');
      p.filterMode = routedTo('lp', 'lp2') ? 'serial' : 'parallel';
      p.filter2 = { mode: lp2.mode, freq: lp2.freq, q: lp2.q, key_track: lp2.key_track ?? 0 };
      p.fenv2 = { ...envOf('fenv2'), amount: by.get('fenv2').amount };
    }
    p.drive = by.has('drv') ? need('drv', 'shaper').drive : 0;
    if (by.has('fm')) p.fm = { on: routedTo('o2', 'fm'), depth: Number((need('fm', 'gain').gain / fmBase(p.osc[1])).toFixed(4)) };
    p.aenv = envOf('aenv');
    p.fenv = { ...envOf('fenv'), amount: by.get('fenv').amount };
    p.penv = { ...envOf('penv'), amount: by.get('penv').amount };
    const lfo = need('lfo', 'osc');
    p.lfo = {
      wave: lfo.wave, rate: lfo.fixed_hz, pitch: need('lfo_p', 'gain').gain,
      cutoff: need('lfo_c', 'gain').gain, amp: need('lfo_a', 'gain').gain,
    };
    // Anything the template would not regenerate identically (extra nodes, rewired edges) is "custom".
    return canonical(buildInstrument(inst.id, p)) === canonical(inst) ? p : null;
  } catch {
    return null;
  }
}

/** True when the instrument is a template instrument still at the default (Init) patch, i.e. nothing edited yet. */
export function isDefaultPatch(inst) {
  const p = parseInstrument(inst);
  const norm = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  return !!p && norm(p) === norm(defaultPatch());
}

// ------------------------------------------------------------------ patch files (export / import)

export const PATCH_FILE_FORMAT = 'band-game-patch';

/** The file contents for exporting an instrument: the shipped preset shape plus a format marker. */
export function patchToFile(inst) {
  return { format: PATCH_FILE_FORMAT, version: 1, label: inst.name ?? inst.id, instrument: inst };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const allNum = (o, keys) => keys.every((k) => isNum(o?.[k]));

/** A message describing the first thing wrong with a parsed patch, or null. Ranges are left to the server. */
export function validatePatch(p) {
  if (!allNum(p, ['gain', 'send_delay', 'send_reverb', 'drive'])) return 'output levels must be numbers';
  if (typeof p.fm?.on !== 'boolean' || !isNum(p.fm.depth)) return 'invalid FM settings';
  for (const o of p.osc) {
    if (!WAVES.includes(o.wave)) return `unknown oscillator wave "${o.wave}"`;
    if (!allNum(o, ['semitones', 'detune', 'level', 'unison', 'spread', 'route']) || (o.fixed_hz != null && !isNum(o.fixed_hz))) return 'oscillator values must be numbers';
  }
  if (!['white', 'pink'].includes(p.noise.color) || !allNum(p.noise, ['level', 'route'])) return 'invalid noise settings';
  if ([...p.osc, p.noise].some((s) => ![0, 1, 2].includes(s.route))) return 'a source is routed to an unknown filter';
  if (!FILTER_ROUTINGS.includes(p.filterMode)) return 'unknown filter routing';
  for (const f of [p.filter, p.filter2]) {
    if (!FILTER_MODES.includes(f?.mode) || !allNum(f, ['freq', 'q', 'key_track'])) return 'invalid filter settings';
  }
  for (const [name, e] of [['amp', p.aenv], ['filter', p.fenv], ['filter 2', p.fenv2], ['pitch', p.penv]]) {
    if (!allNum(e, ['attack', 'decay', 'sustain', 'release']) || (name !== 'amp' && !isNum(e.amount))) return `invalid ${name} envelope`;
  }
  if (!WAVES.includes(p.lfo.wave) || !allNum(p.lfo, ['rate', 'pitch', 'cutoff', 'amp'])) return 'invalid LFO settings';
  return null;
}

/**
 * Parse an exported patch file (or a shipped preset file). Returns {label, patch}; throws an Error with a
 * user-readable message for anything that isn't a patch this editor can open.
 */
export function readPatchFile(text) {
  if (text.length > 200_000) throw new Error('That file is too large to be a patch.');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (raw?.format !== undefined && raw.format !== PATCH_FILE_FORMAT) throw new Error('That is not a patch file from this game.');
  const inst = raw?.instrument;
  if (!inst || !Array.isArray(inst.nodes) || !Array.isArray(inst.edges)) throw new Error('No instrument found in that file.');
  const patch = parseInstrument(inst);
  if (!patch) throw new Error('That patch uses a custom signal graph that this editor cannot open.');
  const bad = validatePatch(patch);
  if (bad) throw new Error(`Invalid patch: ${bad}.`);
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 32) : (inst.name ?? 'Imported');
  return { label, patch, pianoRoll: inst.piano_roll === true };
}
