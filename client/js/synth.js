// Fixed-architecture synth template. The editor works on a flat "patch" (a few dozen numbers); this module
// converts it to and from the orders instrument graph the server validates and renders. The server
// knows nothing about the template: it only ever sees an ordinary node/edge graph.
//
//   o1 o2 o3 noise -> level gains -> (filter | direct) -> bus -> [drive] -> vca -> out
//   aenv -> vca.gain   fenv -> filter.freq   penv -> o*.detune   lfo -> (pitch | cutoff | amp) depth gains
//
// Every module always exists, so switching things on and off never loses settings: a silent oscillator
// is level 0, an unused modulation is amount 0. The one exception is drive, where 0 omits the shaper.

export const OSC_COUNT = 3;
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
export const FILTER_MODES = ['lowpass', 'highpass', 'bandpass', 'notch'];
export const MIN_DRIVE = 0.1; // server minimum for a shaper node

const oscPatch = (level = 0) => ({
  wave: 'sawtooth', semitones: 0, detune: 0, fixed_hz: null, unison: 1, spread: 0, level, filtered: true,
});

export function defaultPatch() {
  return {
    gain: 0.8,
    send_delay: 0,
    send_reverb: 0.1,
    osc: [oscPatch(0.5), oscPatch(), oscPatch()],
    noise: { color: 'white', level: 0, filtered: true },
    filter: { mode: 'lowpass', freq: 2000, q: 1, key_track: 0.5 },
    drive: 0,
    aenv: { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.1 },
    fenv: { attack: 0.005, decay: 0.25, sustain: 0.3, release: 0.1, amount: 0 }, // amount in Hz
    penv: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05, amount: 0 }, // amount in cents
    lfo: { wave: 'sine', rate: 5, pitch: 0, cutoff: 0, amp: 0 }, // depths: cents, Hz, gain
  };
}

const env = (id, e, amount) => ({
  id, type: 'env', attack: e.attack, decay: e.decay, sustain: e.sustain, release: e.release, amount,
});
const gainNode = (id, gain) => ({ id, type: 'gain', gain });

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
    edge(`l${i + 1}`, o.filtered ? 'lp' : 'bus');
    edge('penv', n.id, 'detune');
    edge('lfo_p', n.id, 'detune');
  });
  nodes.push({ id: 'n', type: 'noise', color: p.noise.color }, gainNode('ln', p.noise.level));
  edge('n', 'ln');
  edge('ln', p.noise.filtered ? 'lp' : 'bus');

  nodes.push(
    { id: 'lp', type: 'filter', mode: p.filter.mode, freq: p.filter.freq, q: p.filter.q, key_track: p.filter.key_track },
    gainNode('bus', 1));
  edge('lp', 'bus');
  edge('fenv', 'lp', 'freq');
  edge('lfo_c', 'lp', 'freq');

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
    if (c.type === 'filter') c.key_track ??= 0;
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
        level: need(`l${i + 1}`, 'gain').gain, filtered: routedTo(`l${i + 1}`, 'lp'),
      };
    }
    p.noise = { color: need('n', 'noise').color, level: need('ln', 'gain').gain, filtered: routedTo('ln', 'lp') };
    const lp = need('lp', 'filter');
    p.filter = { mode: lp.mode, freq: lp.freq, q: lp.q, key_track: lp.key_track ?? 0 };
    p.drive = by.has('drv') ? need('drv', 'shaper').drive : 0;
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
  for (const o of p.osc) {
    if (!WAVES.includes(o.wave)) return `unknown oscillator wave "${o.wave}"`;
    if (!allNum(o, ['semitones', 'detune', 'level', 'unison', 'spread']) || (o.fixed_hz != null && !isNum(o.fixed_hz))) return 'oscillator values must be numbers';
  }
  if (!['white', 'pink'].includes(p.noise.color) || !isNum(p.noise.level)) return 'invalid noise settings';
  if (!FILTER_MODES.includes(p.filter.mode) || !allNum(p.filter, ['freq', 'q', 'key_track'])) return 'invalid filter settings';
  for (const [name, e] of [['amp', p.aenv], ['filter', p.fenv], ['pitch', p.penv]]) {
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
